from __future__ import annotations

import hashlib
import secrets
import asyncio
import json
import re
import time
import posixpath
from urllib.parse import quote
from datetime import datetime, timezone
from typing import Any

from ..domain.errors import DomainError
from ..infrastructure.database import Database
from ..infrastructure.kuscia import LiteClient, KusciaError


def _id(connector_id: str, request_key: str) -> str:
    return "ing-" + hashlib.sha256(f"{connector_id}\0{request_key}".encode()).hexdigest()[:32]


def _staging_backend(profile: dict[str, Any], settings: Any) -> str:
    """Resolve the Kuscia ingestion backend at the Portal boundary.

    Older activation records do not carry ``staging_backend``.  The engine
    default must therefore be applied here instead of serializing JSON null,
    which Kuscia correctly rejects as an invalid ingestion request.
    """
    return str(profile.get("staging_backend") or getattr(settings, "engine_upload_backend", "directory"))


def _ftp_columns(columns: Any) -> list[dict[str, str]]:
    """Project platform column metadata onto Kuscia's strict FTP schema."""
    aliases = {
        "tinyint": "integer", "smallint": "integer", "int": "integer",
        "integer": "integer", "bigint": "integer", "float": "double",
        "double": "double", "boolean": "boolean",
    }
    result: list[dict[str, str]] = []
    for column in columns or []:
        if not isinstance(column, dict):
            continue
        name = str(column.get("name") or "").strip()
        type_name = str(column.get("type") or "string").strip().lower()
        type_name = "double" if type_name.startswith("decimal(") else aliases.get(type_name, "string")
        if name:
            result.append({"name": name, "type": type_name})
    return result


class ExtractionService:
    def __init__(self, database: Database, settings: Any, services):
        self.db, self.settings, self.services = database, settings, services
        self.locks = {}

    def save(self, task):
        previous = self.db.durable_read('extraction', task['id']) or {}
        if previous.get('cancel_requested'): task['cancel_requested'] = True
        if previous.get('state') in {'cancelled', 'cleaned'} and task.get('state') not in {previous['state'], 'cleaned'}:
            raise DomainError(409, 'extraction_already_terminal')
        task['updated_at'] = datetime.now(timezone.utc).isoformat()
        self.db.durable_write('extraction', task['id'], task, task['state'])

    def task(self, task_id: str, connector_id: str) -> dict[str, Any]:
        value = self.db.durable_read("extraction", task_id)
        if not value or value.get("connector_id") != connector_id: raise DomainError(404, "接入任务不存在或不属于当前连接器")
        return value

    def create(self, body: dict[str, Any], connector_id: str, profile: dict[str, Any]) -> dict[str, Any]:
        if not body.get("request_key") or not body.get("resource_ref") or not body.get("resource_version"): raise DomainError(422, "需要 request_key、resource_ref 和 resource_version")
        if not profile.get("domain_id") or not profile.get("engine_datasource_ref"): raise DomainError(409, "隐私计算引擎尚未配置输入数据源")
        output_format = str(body.get("output_format") or body.get("format") or "").strip().lower()
        if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,31}', output_format):
            raise DomainError(422, "计算输入需要声明单文件格式")
        if body.get('content_mode') not in (None, 'structured', 'raw'):
            raise DomainError(422, 'invalid_compute_content_mode')
        if body.get('content_mode') == 'structured' and output_format != 'csv':
            raise DomainError(422, 'structured_compute_output_must_be_csv')
        body = {**body, 'output_format': output_format}
        task_id = _id(connector_id, str(body["request_key"])); existing = self.db.durable_read("extraction", task_id)
        if existing:
            if existing.get('request_digest') != hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest(): raise DomainError(409, 'extraction_request_conflict')
            return existing
        task = {"request_digest": hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest(), "id": task_id, "connector_id": connector_id, "resource_ref": str(body["resource_ref"]), "resource_version": str(body["resource_version"]),
                "domain_id": profile["domain_id"], "engine_datasource_ref": profile["engine_datasource_ref"], "mode": body.get("mode") or "di",
                "plan": body, "recovery_token": secrets.token_hex(32), "job_id": str(int.from_bytes(secrets.token_bytes(8), "big") & ((1 << 62) - 1) or 1),
                "state": "queued", "phase": "queued", "created_at": datetime.now(timezone.utc).isoformat(), "updated_at": datetime.now(timezone.utc).isoformat()}
        self.save(task); return task

    def public(self, task: dict[str, Any]) -> dict[str, Any]:
        return {"channel": "extractions", "registers_compute_input": True, **{key: task.get(key) for key in ("id", "connector_id", "resource_ref", "resource_version", "mode", "state", "phase", "session_id", "di_task_id", "job_id", "engine_status", "batch", "received_files", "resources", "error", "created_at", "updated_at")}}

    async def credentials(self, task_id: str, connector_id: str, profile: dict[str, Any]) -> dict[str, Any]:
        task = self.task(task_id, connector_id); client = LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"])
        raw = task['plan'].get('content_mode') == 'raw' or task['plan'].get('output_format') != 'csv'
        result = await client.ftp_request("POST", "", {"connector_id": connector_id, "task_id": task_id, "resource_version": task["resource_version"], "backend": _staging_backend(profile, self.settings), "format": 'raw' if raw else 'csv', "columns": [] if raw else _ftp_columns(task["plan"].get("columns")), "header": not raw, "request_id": task_id, "recovery_token": task["recovery_token"]})
        session = result.get("session") or {}; task.update({"session_id": session.get("id"), "batch": session, "state": "awaiting-upload", "phase": "uploading"}); self.save(task)
        return {"host": profile.get("ftp_host") or self.settings.engine_upload_host, "port": profile.get("ftp_port") or self.settings.engine_upload_port, "username": result.get("username"), "password": result.get("password"), "directory": result.get("directory"), "session_id": session.get("id"), "expires_at": session.get("expires_at")}

    async def run(self, task_id: str, connector_id: str, profile: dict[str, Any]) -> dict[str, Any]:
        async with self.locks.setdefault(task_id, asyncio.Lock()):
            return await self._run(task_id, connector_id, profile)

    async def _run(self, task_id: str, connector_id: str, profile: dict[str, Any]) -> dict[str, Any]:
        task = self.task(task_id, connector_id)
        if task.get("state") == "ready": return task
        manual = task.get("mode") == "manual"
        if task.get('state') in {'cancelled', 'cleaned'}: return task
        try:
            if not manual and not task.get('binding'):
                resource_id = str(task['plan'].get('dr_resource_id') or '')
                match = re.fullmatch(r'V?([1-9][0-9]*)', task['resource_version'])
                if not resource_id or not match: raise DomainError(422, 'invalid_dr_resource_version')
                located = await self.services.json('dr', connector_id, 'GET',
                    '/api/v1/resources/' + quote(resource_id, safe='') + '/versions/' + match[1] + '/locator')
                if located.get('resource_id') != resource_id or located.get('version') != int(match[1]):
                    raise DomainError(502, 'resource_locator_mismatch')
                raw = task['plan'].get('content_mode') == 'raw' or task['plan'].get('output_format') != 'csv'
                if not raw and not located.get('data_items'): raise DomainError(422, 'compute_requires_structured_resource')
                if raw and str(located.get('resource_format') or '').lower() != task['plan'].get('output_format'):
                    raise DomainError(422, 'raw_compute_format_must_match_resource')
                task['binding'] = located
                task['plan']['columns'] = [] if raw else located['data_items']
                self.save(task)
            client = LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"])
            existing = None
            if not manual:
                try:
                    existing = await self.services.json('di', connector_id, 'GET',
                        '/internal/v1/compute-transfers/by-request/' + task_id)
                except DomainError as exc:
                    if exc.status_code != 404: raise
            if not existing:
                upload = await self.credentials(task_id, connector_id, profile)
                task = self.task(task_id, connector_id)
            session_id = task['session_id']
            session = await client.ftp_request('GET', f'/{session_id}')
            if session.get('state') in {'revoked', 'cleaned', 'expired'}:
                if existing and existing['state'] not in {'succeeded', 'failed', 'cancelled', 'expired'}:
                    await self.services.json('di', connector_id, 'POST', '/internal/v1/compute-transfers/' + existing['id'] + '/cancel', {})
                raise DomainError(409, 'compute_session_expired_create_new_attempt')
            task.update({'state': 'running', 'phase': 'extracting'})
            self.save(task)
            if manual:
                files = task.get('expected_files') or []
                if not files: raise DomainError(409, '请上传文件并确认完成')
            else:
                if not existing:
                    binding = task['binding']
                    expires = upload.get('expires_at')
                    if isinstance(expires, str):
                        expires = datetime.fromisoformat(expires.replace('Z', '+00:00')).timestamp()
                    if not isinstance(expires, (float, int)) or expires <= time.time():
                        raise DomainError(409, 'compute_session_expired')
                    payload = {'request_id': task_id, 'source_id': binding['source_id'], 'object_ref': binding['object_ref'],
                        'input_format': binding['resource_format'].lower(), 'columns': task['plan']['columns'],
                        'delivery_mode': 'raw' if task['plan'].get('content_mode') == 'raw' or task['plan'].get('output_format') != 'csv' else 'structured',
                        'target_binding': profile.get('compute_target_binding') or self.settings.compute_target_binding,
                        'session_id': session_id, 'directory': posixpath.join(upload.get('directory') or '/', 'result'),
                        'username': upload['username'], 'password': upload['password'], 'expires_at': expires}
                    existing = await self.services.json('di', connector_id, 'POST', '/internal/v1/compute-transfers', payload, key=task_id)
                task['di_task_id'] = existing['id']
                task['job_id'] = existing['job_id']
                task['engine_status'] = existing['state']
                self.save(task)
                # Bound one supervisor turn; unfinished work is resumed by the durable recovery loop.
                for _ in range(20):
                    if self.task(task_id, connector_id).get('cancel_requested'):
                        await self.services.json('di', connector_id, 'POST', '/internal/v1/compute-transfers/' + existing['id'] + '/cancel', {})
                    current = await self.services.json('di', connector_id, 'GET', '/internal/v1/compute-transfers/by-request/' + task_id)
                    if task.get('engine_status') != current['state']:
                        task['engine_status'] = current['state']; self.save(task)
                    if current['state'] == 'succeeded': break
                    if current['state'] in {'failed', 'expired', 'cancelled', 'needs_attention'}:
                        raise DomainError(409, 'di_compute_' + current['state'])
                    await asyncio.sleep(1)
                else: return task
                # Once publication starts, the session is frozen and /files
                # rejects inventory requests. Replay complete with its durable
                # manifest to recover an interrupted commit without re-upload.
                if session.get('state') in {'committing', 'staged'}:
                    files = session.get('files') or []
                else:
                    files = (await client.ftp_request('GET', f'/{session_id}/files')).get('files', [])
                if not files: raise DomainError(502, 'FTP 接收清单为空')
            if self.task(task_id, connector_id).get('cancel_requested'):
                raise DomainError(409, 'extraction_cancel_requested')
            output_format = str(task['plan'].get('output_format') or 'csv')
            raw = task['plan'].get('content_mode') == 'raw' or output_format != 'csv'
            if raw and len(files) != 1: raise DomainError(422, 'raw_compute_requires_single_file')
            columns = task['plan'].get('columns') or []
            task['phase'] = 'committing'
            self.save(task)
            committed = await client.ftp_request("POST", f"/{session_id}/complete", {"files": files})
            resources = [{
                "engine_input_id": f"{task_id}-{i}",
                "relative_uri": f"{committed.get('relative_uri', '')}/{item.get('path', '')}",
                "sha256": item.get("sha256"),
                "size": item.get("size"),
                "format": output_format,
                "columns": columns,
            } for i, item in enumerate(files)]
            for resource in resources:
                try: await client.create_domain_data(domain_id=task["domain_id"], data_id=resource["engine_input_id"], name=task["resource_ref"], relative_uri=resource["relative_uri"], columns=columns, datasource_id=task["engine_datasource_ref"], data_type='file' if raw else 'table', attributes={"sha256": resource["sha256"], "resource_version": task["resource_version"], "ftp_session_id": session_id, "format": output_format})
                except Exception as exc:
                    if "exist" not in str(exc).lower(): raise
                registered = await client.query_domain_data(task["domain_id"], resource["engine_input_id"])
                if registered.get("relative_uri") != resource["relative_uri"] or registered.get("datasource_id") != task["engine_datasource_ref"]: raise DomainError(502, "计算输入登记核对失败")
                content, _ = await client.download_file(resource["relative_uri"])
                if len(content) != int(resource["size"] or 0) or hashlib.sha256(content).hexdigest() != resource["sha256"]: raise DomainError(502, "已登记输入读取校验失败")
            task.update({"state": "ready", "phase": "ready", "batch": committed, "resources": resources, "engine_status": "FINISHED"}); self.save(task); return task
        except Exception as exc:
            state = 'running' if isinstance(exc, DomainError) and exc.status_code == 503 else 'failed'
            task.update({'state': state, 'error': {'phase': task.get('phase'), 'message': str(exc) if isinstance(exc, DomainError) else 'compute_preparation_unavailable', 'retryable': state == 'running'}})
            self.save(task)
            raise

    async def received(self, task_id: str, connector_id: str, profile: dict[str, Any]) -> dict[str, Any]:
        task = self.task(task_id, connector_id)
        if not task.get("session_id"): return self.public(task)
        client = LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"])
        session = await client.ftp_request("GET", f"/{task['session_id']}")
        files = (await client.ftp_request("GET", f"/{task['session_id']}/files")).get("files", []) if session.get("state") == "uploading" else session.get("files", [])
        task.update({"batch": session, "received_files": files}); self.save(task); return self.public(task)

    async def cancel(self, task_id: str, connector_id: str, profile: dict[str, Any]) -> dict[str, Any]:
        task = self.task(task_id, connector_id)
        if task.get('state') == 'ready' or task.get('resources') or task.get('phase') == 'committing': raise DomainError(409, '任务已登记输入，不能撤销')
        task['cancel_requested'] = True
        self.save(task)
        if task.get('mode') != 'manual':
            try:
                delivery = await self.services.json('di', connector_id, 'GET', '/internal/v1/compute-transfers/by-request/' + task_id)
            except DomainError as exc:
                if exc.status_code != 404: raise
            else:
                if delivery['state'] not in {'succeeded', 'failed', 'cancelled', 'expired'}:
                    await self.services.json('di', connector_id, 'POST', '/internal/v1/compute-transfers/' + delivery['id'] + '/cancel', {})
                    raise DomainError(409, 'di_cancellation_pending')
        if task.get("session_id"): await LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"]).ftp_request("POST", f"/{task['session_id']}/revoke", {})
        task.update({"state": "cancelled", "phase": "cancelled"}); self.save(task); return task

    async def cleanup(self, task_id: str, connector_id: str, profile: dict[str, Any], *, release: bool = False, release_proof: dict[str, Any] | None = None) -> dict[str, Any]:
        task = self.task(task_id, connector_id)
        if task.get("state") not in {"ready", "failed", "cancelled", "awaiting-upload"}: raise DomainError(409, "任务仍在执行，不能清理")
        if task.get('mode') != 'manual':
            try:
                delivery = await self.services.json('di', connector_id, 'GET', '/internal/v1/compute-transfers/by-request/' + task_id)
            except DomainError as exc:
                if exc.status_code != 404: raise
            else:
                if delivery['state'] not in {'succeeded', 'failed', 'cancelled', 'expired'}:
                    raise DomainError(409, 'di_delivery_not_terminal')
        if task.get("session_id"):
            client=LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"])
            if release:
                scope=release_proof.get('reference_scope') if isinstance(release_proof,dict) else None
                required={task_id,task['session_id']}|{str(r['engine_input_id']) for r in task.get('resources') or []}
                if (not isinstance(scope,list) or not all(isinstance(r,str) for r in scope) or not required<=set(scope)
                        or release_proof.get('references_clear') is not True or release_proof.get('reference_hash')!=hashlib.sha256(json.dumps(sorted(scope),separators=(',',':')).encode()).hexdigest()):
                    raise DomainError(409,'input_release_proof_mismatch')
                # Only the signed, quiescent run lifecycle uses release=True.
                # Never delete a resource merely because a caller knows its id.
                for resource in task.get('resources') or []:
                    identifier=str(resource.get('engine_input_id') or '')
                    if not identifier.startswith(task_id+'-'):
                        raise DomainError(409,'input_release_resource_id_mismatch')
                    try: registered=await client.query_domain_data(task['domain_id'],identifier)
                    except KusciaError as exc:
                        if exc.status_code==404 or any(s in str(exc).lower() for s in ('not found','not exist')):continue
                        raise
                    attributes=registered.get('attributes') or {}
                    if (registered.get('relative_uri')!=resource.get('relative_uri') or
                            attributes.get('ftp_session_id')!=task['session_id'] or
                            str(attributes.get('resource_version'))!=str(task['resource_version'])):
                        raise DomainError(409,'input_release_resource_ownership_mismatch')
                    try:await client.delete_domain_data(task['domain_id'],identifier)
                    except KusciaError as exc:
                        if exc.status_code!=404 and not any(s in str(exc).lower() for s in ('not found','not exist')):raise
            await client.ftp_request("POST", f"/{task['session_id']}/cleanup", {'release':True,'proof':release_proof} if release else {})
        task.update({"state": "cleaned", "phase": "cleaned", "recovery_token": "", "plan": {}}); self.save(task); return task
