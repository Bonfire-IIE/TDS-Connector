from __future__ import annotations

import asyncio
import hashlib
import json
import re
from datetime import datetime, timezone
from typing import Any

from ..domain.errors import DomainError
from ..infrastructure.database import Database
from ..infrastructure.kuscia import LiteClient
from .extraction import ExtractionService


def _key(run_id: str, connector_id: str) -> str:
    return hashlib.sha256(f"{connector_id}\0{run_id}".encode()).hexdigest()


def _engine_task_id(job_id, node_id):
    value=f"{job_id}-{node_id}"
    return value if len(value)<=63 else value[:54]+"-"+hashlib.sha256(value.encode()).hexdigest()[:8]


def _render(value: Any, context: dict[str, Any]) -> Any:
    if isinstance(value, list): return [_render(item, context) for item in value]
    if isinstance(value, dict): return {key: _render(item, context) for key, item in value.items()}
    if not isinstance(value, str): return value
    exact = re.fullmatch(r"\{\{\s*([^{}]+?)\s*\}\}", value)
    if exact:
        current: Any = context
        for part in exact.group(1).split("."):
            if not isinstance(current, dict) or part not in current:
                raise DomainError(422, f"任务模板变量不存在: {exact.group(1)}")
            current = current[part]
        return current
    def replace(match: re.Match[str]) -> str:
        key = match.group(1).strip(); current: Any = context
        for part in key.split("."):
            if not isinstance(current, dict) or part not in current:
                raise DomainError(422, f"任务模板变量不存在: {key}")
            current = current[part]
        if isinstance(current, (dict, list)):
            raise DomainError(422, "对象模板变量必须独占一个值")
        return str(current if current is not None else "")
    return re.sub(r"\{\{\s*([^{}]+?)\s*\}\}", replace, value)


def _resource_version(resource: dict[str, Any]) -> str:
    return str(resource.get("version") or resource.get("resource_version") or
               (resource.get("metadata") or {}).get("version") or
               hashlib.sha256(json.dumps(resource.get("metadata") or {}, sort_keys=True).encode()).hexdigest())


def _resources(request: dict[str, Any]) -> list[dict[str, Any]]:
    values = request.get("resources")
    if isinstance(values, list) and values:
        return _unique_resource_refs([item for item in values if isinstance(item, dict)])
    result = []
    for role in ("provider", "consumer"):
        resource = request.get(f"{role}_resource")
        if isinstance(resource, dict):
            result.append({**resource, "connector_id": request.get(f"{role}_connector_id"),
                           "ref": request.get(f"{role}_resource_ref") or resource.get("ref")})
    return _unique_resource_refs(result)


def _unique_resource_refs(resources):
    owners = {}
    for resource in resources:
        ref, owner = str(resource.get("ref") or ""), str(resource.get("connector_id") or "")
        if ref in owners and owners[ref] != owner:
            raise DomainError(422, "跨连接器资源引用重名，请使用唯一的中心资源标识")
        owners[ref] = owner
    return resources


def _compute_input_spec(resource: dict[str, Any], request: dict[str, Any]) -> dict[str, str]:
    """File ports preserve resource bytes; table ports keep CSV preparation."""
    metadata = resource.get("metadata") or {}
    fmt = str(metadata.get("resource_format") or metadata.get("input_format") or metadata.get("format") or "").lower()
    kind = str(metadata.get("data_type") or metadata.get("kind") or "").lower()
    reference = str(resource.get("ref") or "")
    applications = request.get("applications") or {}
    nodes = (request.get("workflow") or {}).get("nodes") or []
    for node in nodes:
        app = applications.get(str(node.get("app_image") or "")) or request.get("application") or {}
        ports = (((app.get("implementation_metadata") or {}).get("appimage") or {}).get("io_schema") or {}).get("inputs") or []
        for binding in node.get("input_bindings") or []:
            owner = str(binding.get("domain_id") or binding.get("connector_id") or "")
            if owner and owner != str(resource.get("connector_id") or ""):
                continue
            if binding.get("source_node") or str(binding.get("domaindata_id") or binding.get("resource_ref") or "") != reference:
                continue
            port = next((p for p in ports if p.get("name") == binding.get("port")), {})
            if str(port.get("kind") or "").lower() in {"file", "binary", "unstructured"}:
                kind = "file"
                if not fmt and len(port.get("formats") or []) == 1:
                    fmt = str(port["formats"][0]).lower()
    raw = kind in {"file", "binary", "unstructured"} or (fmt and fmt not in {"csv", "tsv", "json", "jsonl", "parquet", "orc"})
    if raw and not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,31}", fmt):
        raise DomainError(422, "非结构化计算输入缺少资源文件格式")
    return {"output_format": fmt if raw else "csv", "content_mode": "raw" if raw else "structured"}


def _manifest_bundle(run_id: str, connector_id: str, domain_id: str,
                     manifests: dict[str, dict[str, Any]]) -> dict[str, Any]:
    return {"run_id": run_id, "connector_id": connector_id, "domain_id": domain_id,
            "manifests": list(manifests.values())}


def _validate_peer_bundle(value: dict[str, Any], request: dict[str, Any], peer_connector_id: str,
                          peer_domain_id: str, run_id: str) -> dict[str, dict[str, Any]]:
    manifests = value.get("manifests") if isinstance(value, dict) else None
    if manifests is None and isinstance(value, dict) and value.get("resource_ref"):
        manifests = [value]
    if (str(value.get("run_id") or "") != run_id
            or str(value.get("connector_id") or "") != peer_connector_id
            or str(value.get("domain_id") or "") != peer_domain_id
            or not isinstance(manifests, list)):
        raise DomainError(409, "对端输入清单集合的运行或归属不匹配")
    expected = {str(item.get("ref") or ""):_resource_version(item) for item in _resources(request)
                if str(item.get("connector_id") or "") == peer_connector_id}
    result = {}
    for manifest in manifests:
        reference = str((manifest or {}).get("resource_ref") or "")
        if reference not in expected:
            raise DomainError(409, "对端返回了本次执行未声明的数据资源")
        _validate_peer_manifest(manifest, {"run_id":run_id,
            "connector_id":peer_connector_id,"domain_id":peer_domain_id,"resource_ref":reference,
            "resource_version":expected[reference],
            "format":_compute_input_spec(next(item for item in _resources(request) if str(item.get("ref") or "") == reference), request)["output_format"]})
        result[reference]=manifest
    if set(result)!=set(expected):
        raise DomainError(409, "对端输入清单不完整")
    return result


def _data_uri(relative_uri: str) -> str:
    relative = str(relative_uri or "").lstrip("/")
    if not relative or "\\" in relative or ".." in relative.split("/"):
        raise DomainError(422, "应用输入输出包含非法相对路径")
    return "/home/kuscia/var/storage/data/" + relative


def _io_context(request: dict[str, Any], app: dict[str, Any], provider_uri: str,
                consumer_uri: str, external_run_ref: str) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    """Bind workflow ports to materialized resources without application-specific names."""
    workflow = request.get("workflow") or {}
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else []
    app_name = str(app.get("name") or "")
    node = next((item for item in (nodes or []) if isinstance(item, dict)
                 and str(item.get("app_image") or "") == app_name), None)
    if node is None and len(nodes or []) == 1 and isinstance(nodes[0], dict):
        node = nodes[0]
    if node is None:
        raise DomainError(422, "执行请求缺少当前 AppImage 的工作流节点")

    provider_ref, consumer_ref = str(request.get("provider_resource_ref") or ""), str(request.get("consumer_resource_ref") or "")
    provider_id, consumer_id = str(request.get("provider_connector_id") or ""), str(request.get("consumer_connector_id") or "")
    descriptors = {
        "provider": (request.get("provider_resource") or {}, provider_uri),
        "consumer": (request.get("consumer_resource") or {}, consumer_uri),
    }
    inputs: dict[str, Any] = {}
    bindings = {str(item.get("port") or ""): item for item in node.get("input_bindings") or [] if isinstance(item, dict)}
    for port in (app.get("io_schema") or {}).get("inputs") or []:
        name = str(port.get("name") or "")
        binding = bindings.get(name)
        if not name or not binding:
            if port.get("required", True):
                raise DomainError(422, f"工作流缺少应用输入端口绑定: {name or '未命名端口'}")
            continue
        reference = str(binding.get("domaindata_id") or binding.get("resource_ref") or "")
        owner = str(binding.get("connector_id") or binding.get("domain_id") or "")
        if reference == provider_ref or (not reference and owner == provider_id):
            resource, uri = descriptors["provider"]
        elif reference == consumer_ref or (not reference and owner == consumer_id):
            resource, uri = descriptors["consumer"]
        else:
            raise DomainError(422, f"应用输入端口 {name} 未绑定本次执行的数据资源")
        metadata = (resource or {}).get("metadata") or {}
        inputs[name] = {**metadata, "relative_uri": uri, "resource_ref": reference,
                        "data_type": metadata.get("data_type") or port.get("kind")}

    outputs: dict[str, dict[str, Any]] = {}
    output_bindings = {str(item.get("port") or ""): item for item in node.get("output_bindings") or [] if isinstance(item, dict)}
    for port in (app.get("io_schema") or {}).get("outputs") or []:
        name = str(port.get("name") or "")
        if not name:
            raise DomainError(422, "应用输出端口缺少名称")
        binding = output_bindings.get(name) or {}
        formats = port.get("formats") or []
        configured_format = str(binding.get("format") or "")
        if not configured_format and len(formats) == 1:
            configured_format = str(formats[0])
        relative = str(binding.get("relative_uri") or "")
        if not configured_format and relative.rsplit(".", 1)[-1] != relative:
            configured_format = relative.rsplit(".", 1)[-1].lower()
        if not configured_format:
            raise DomainError(422, f"应用输出端口 {name} 未声明唯一格式")
        relative = relative or f"outputs/{external_run_ref}-{name}.{configured_format}"
        outputs[name] = {
            "relative_uri": _data_uri(relative), "format": configured_format,
            "data_type": port.get("kind") or "table", "resource_ref": binding.get("domaindata_id"),
        }
    return inputs, outputs


def _compile_job(request: dict[str, Any], manifests: dict[str, dict[str, Any]],
                 external_run_ref: str, connector_domains: dict[str, str]) -> tuple[dict[str, Any], dict[str, Any], list[dict[str, Any]]]:
    workflow = request.get("workflow") or {}
    nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
    if not isinstance(nodes, list) or not nodes:
        raise DomainError(422, "执行请求缺少工作流节点")
    applications = request.get("applications") if isinstance(request.get("applications"), dict) else {}
    if not applications and len(nodes) == 1 and isinstance(request.get("application"), dict):
        applications = {str(nodes[0].get("app_image") or ""):request["application"]}
    descriptors = {str(item.get("ref") or ""):item for item in _resources(request)}
    resource_inputs: dict[str, dict[str, Any]] = {}
    for reference, manifest in manifests.items():
        objects = manifest.get("resources") or []
        if len(objects) != 1:
            raise DomainError(422, f"数据资源 {reference} 必须接入为一个计算输入对象")
        metadata = (descriptors.get(reference) or {}).get("metadata") or {}
        resource_inputs[reference] = {
            **metadata, "resource_ref": reference,
            "relative_uri": _data_uri(str(objects[0].get("relative_uri") or "")),
            "sha256": objects[0].get("sha256"),
            "format": str(objects[0].get("format") or "").lower(),
            "columns": objects[0].get("columns") or metadata.get("columns") or [],
        }

    outputs_by_ref: dict[str, dict[str, Any]] = {}
    node_outputs: dict[str, dict[str, Any]] = {}
    for node in nodes:
        application = applications.get(str(node.get("app_image") or ""))
        app = ((application or {}).get("implementation_metadata") or {}).get("appimage") or {}
        definitions = {str(port.get("name") or ""):port for port in (app.get("io_schema") or {}).get("outputs") or []}
        values = {}
        for binding in node.get("output_bindings") or []:
            name = str(binding.get("port") or "")
            definition = definitions.get(name) or {}
            formats = definition.get("formats") or []
            relative = str(binding.get("relative_uri") or "")
            fmt = str(binding.get("format") or "")
            if not fmt and len(formats) == 1: fmt = str(formats[0])
            if not fmt and relative.rsplit(".", 1)[-1] != relative: fmt = relative.rsplit(".", 1)[-1].lower()
            if not name or not fmt:
                raise DomainError(422, f"节点 {node.get('id')} 的输出端口定义不完整")
            relative = relative or f"outputs/{external_run_ref}-{node.get('id')}-{name}.{fmt}"
            item = {"relative_uri":_data_uri(relative),"format":fmt,
                    "data_type":definition.get("kind") or "table",
                    "resource_ref":binding.get("domaindata_id")}
            values[name] = item
            if binding.get("domaindata_id"): outputs_by_ref[str(binding["domaindata_id"])] = item
        node_outputs[str(node.get("id") or "")] = values

    dependencies: dict[str, list[str]] = {str(node.get("id") or ""):[] for node in nodes}
    for edge in workflow.get("edges") or []:
        source, target = str(edge.get("source") or ""), str(edge.get("target") or "")
        if source and target and source not in dependencies.setdefault(target, []): dependencies[target].append(source)
    by_id = {str(node.get("id") or ""):node for node in nodes}
    tasks, images = [], {}
    for node in nodes:
        node_id, app_name = str(node.get("id") or ""), str(node.get("app_image") or "")
        application = applications.get(app_name)
        metadata = (application or {}).get("implementation_metadata") or {}
        app = metadata.get("appimage") or {}
        template = (application or {}).get("task_input_template")
        if not app.get("name") or template is None:
            raise DomainError(422, f"节点 {node_id} 缺少完整 AppImage 定义或 task_input_template")
        images[str(app["name"])] = app
        input_definitions = {str(port.get("name") or ""):port for port in (app.get("io_schema") or {}).get("inputs") or []}
        inputs = {}
        for binding in node.get("input_bindings") or []:
            name, reference = str(binding.get("port") or ""), str(binding.get("domaindata_id") or binding.get("resource_ref") or "")
            if name not in input_definitions:
                raise DomainError(422, f"节点 {node_id} 的输入端口 {name} 未在 AppImage 中声明")
            value = outputs_by_ref.get(reference) if binding.get("source_node") else resource_inputs.get(reference)
            if not value:
                raise DomainError(422, f"节点 {node_id} 的输入端口 {name} 没有已接入的数据对象")
            allowed_formats = {str(item).lower() for item in input_definitions[name].get("formats") or []}
            actual_format = str(value.get("format") or "").lower()
            if allowed_formats and actual_format not in allowed_formats:
                raise DomainError(
                    422,
                    f"节点 {node_id} 的输入端口 {name} 不支持格式 {actual_format or '未声明'}",
                )
            inputs[name] = value
        for name, definition in input_definitions.items():
            if definition.get("required", True) and name not in inputs:
                raise DomainError(422, f"节点 {node_id} 缺少必填输入端口 {name}")
        context = {"project":{"id":request.get("project_id", "")},"run":{"id":request.get("request_id", "")},
                   "task":{"id":node_id},"inputs":inputs,"outputs":node_outputs.get(node_id,{}),
                   "parameters":node.get("parameters") or {}}
        rendered = _render(template, context)
        parties=[]
        for party in node.get("parties") or []:
            connector = str(party.get("connector_id") or party.get("domain_id") or "")
            domain = connector_domains.get(connector)
            if not domain: raise DomainError(422, f"节点 {node_id} 的参与方未映射到执行 Domain")
            parties.append({"domain_id":domain,"role":str(party.get("role") or "")})
        task_id=_engine_task_id(external_run_ref,node_id)
        task={"task_id":task_id,"alias":str(node.get("alias") or node_id),
              "app_image":str(app["name"]),"parties":parties,"priority":int(node.get("priority") or 100),
              "task_input_config":rendered if isinstance(rendered,str) else json.dumps(rendered,ensure_ascii=False)}
        if dependencies.get(node_id):
            task["dependencies"]=[str(by_id[source].get("alias") or source) for source in dependencies[node_id]]
        tasks.append(task)
    job={"job_id":external_run_ref,"initiator":connector_domains[str(request.get("dispatch_connector_id") or "")],
         "schedule_mode":workflow.get("schedule_mode") or "Strict",
         "max_parallelism":int(workflow.get("max_parallelism") or len(tasks)),"tasks":tasks}
    return job, node_outputs, list(images.values())


def _validate_peer_manifest(value: dict[str, Any], expected: dict[str, str]) -> None:
    scalar = {
        "run_id": expected["run_id"], "connector_id": expected["connector_id"],
        "domain_id": expected["domain_id"], "resource_ref": expected["resource_ref"],
        "resource_version": expected["resource_version"],
    }
    if any(str(value.get(key) or "") != wanted for key, wanted in scalar.items()):
        raise DomainError(409, "对端输入引用的归属或版本不匹配")
    task_id = str(value.get("ingestion_task_id") or ""); session_id = str(value.get("session_id") or "")
    resources = value.get("resources")
    if not re.fullmatch(r"ing-[a-f0-9]{32}", task_id) or not re.fullmatch(r"[a-f0-9]{32}", session_id) or not isinstance(resources, list) or len(resources) != 1:
        raise DomainError(409, "对端输入清单无效")
    prefix = f"staging/ftp/{session_id}/files/"
    for resource in resources:
        relative = str(resource.get("relative_uri") or "")
        digest = str(resource.get("sha256") or "")
        data_format = str(resource.get("format") or "").lower()
        columns = resource.get("columns")
        if (not relative.startswith(prefix) or ".." in relative.split("/") or "\\" in relative or
                not str(resource.get("engine_input_id") or "").startswith(task_id + "-") or
                not re.fullmatch(r"[a-f0-9]{64}", digest) or data_format != expected.get("format", "csv") or
                not isinstance(columns, list)):
            raise DomainError(409, "对端输入引用越界或清单无效")


class ExecutionService:
    def __init__(self, database: Database, extraction: ExtractionService | None = None):
        self.db, self.extraction = database, extraction
        self.locks = {}

    def get(self, run_id: str, connector_id: str) -> dict[str, Any] | None:
        return self.db.durable_read("execution", _key(run_id, connector_id))

    def save(self, run_id: str, connector_id: str, value: dict[str, Any]) -> None:
        self.db.durable_write("execution", _key(run_id, connector_id), value, str(value.get("status") or "accepted"))

    def prepare(self, run_id: str, connector_id: str, request: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
        if request.get("provider_connector_id") != connector_id and request.get("consumer_connector_id") != connector_id:
            participants = {str(p.get("connector_id") or "") for p in request.get("participants") or []}
            if connector_id not in participants:
                raise DomainError(403, "执行请求不属于当前连接器")
            from .delegations import validate_receipt
            validate_receipt(self.db, connector_id, request)
        if not profile.get("domain_id") or not profile.get("engine_datasource_ref"): raise DomainError(409, "本地引擎尚未配置输入数据源")
        old = self.get(run_id, connector_id)
        fingerprint = hashlib.sha256(json.dumps(request, sort_keys=True, ensure_ascii=True).encode()).hexdigest()
        if old and old.get("request_hash") != fingerprint: raise DomainError(409, "执行请求已绑定其他资源或应用")
        value = old or {"run_id": run_id, "connector_id": connector_id, "request_hash": fingerprint, "request": request,
                        "external_run_ref": f"kuscia-{hashlib.sha256(run_id.encode()).hexdigest()[:28]}", "status": "accepted"}
        value["validated"] = True; self.save(run_id, connector_id, value); return value

    async def execute(self, run_id: str, connector_id: str, request: dict[str, Any], profile: dict[str, Any], database: Database,
                      peer_prepared: dict[str, Any] | None = None,
                      prepare_only: bool = False) -> dict[str, Any]:
        async with self.locks.setdefault((run_id, connector_id), asyncio.Lock()):
            return await self._execute(run_id, connector_id, request, profile, database, peer_prepared, prepare_only)

    async def _execute(self, run_id, connector_id, request, profile, database, peer_prepared=None, prepare_only=False):
        value = self.prepare(run_id, connector_id, request, profile)
        if value.get("submitted"): return await self.sync(run_id, connector_id, profile)
        if self.extraction:
            prepared = dict(value.get("prepared_manifests") or {})
            for resource in _resources(request):
                if str(resource.get("connector_id") or "") != connector_id:
                    continue
                reference = str(resource.get("ref") or "")
                if reference in prepared:
                    continue
                metadata = resource.get("metadata") or {}
                dr_resource_id = str(metadata.get('dr_resource_id') or resource.get('ref') or '')
                if not reference or not dr_resource_id:
                    raise DomainError(422, '执行请求缺少 DR 资源引用')
                extraction_task = self.extraction.create({
                    'request_key': f'compute:{run_id}:{reference}', 'resource_ref': reference,
                    'resource_version': _resource_version(resource), 'dr_resource_id': dr_resource_id,
                    **_compute_input_spec(resource, request),
                }, connector_id, profile)
                pending = list(value.get('extraction_task_ids') or [])
                if extraction_task['id'] not in pending:
                    pending.append(extraction_task['id'])
                    value['extraction_task_ids'] = pending
                    self.save(run_id, connector_id, value)
                for _ in range(1):
                    extraction_task = await self.extraction.run(extraction_task['id'], connector_id, profile)
                    if extraction_task.get('state') == 'ready': break
                if extraction_task.get('state') != 'ready':
                    raise DomainError(409, 'compute_inputs_preparing')
                prepared[reference] = {
                    "run_id": run_id, "connector_id": connector_id, "domain_id": str(profile["domain_id"]),
                    "resource_ref": reference, "resource_version": _resource_version(resource),
                    "ingestion_task_id": extraction_task["id"],
                    "session_id": str(extraction_task.get("session_id") or ""),
                    "resources": extraction_task.get("resources") or [],
                }
                value["prepared_manifests"] = prepared
                self.save(run_id, connector_id, value)
            value["prepared_manifests"] = prepared
            value["prepared_manifest"] = next(iter(prepared.values()), None)
            value["prepared_input"] = [item for manifest in prepared.values() for item in manifest.get("resources") or []]
            value["prepared_bundle"] = _manifest_bundle(run_id, connector_id, str(profile["domain_id"]), prepared)
            self.save(run_id, connector_id, value)
        if request.get("scheduling_mode") == "master-lite" or profile.get("scheduling_mode") == "master-lite":
            if not prepare_only:
                raise DomainError(409, "Lite 仅准备输入，作业提交归中心 Master")
            value["status"] = "accepted"
            self.save(run_id, connector_id, value)
            return value
        peer = request.get("consumer_execution_node_ref") if request.get("provider_connector_id") == connector_id else request.get("provider_execution_node_ref")
        local_domain = str(profile["domain_id"]); peer_domain = str(peer or "")
        if not peer_domain: raise DomainError(422, "执行请求缺少对端引擎节点")
        client = LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"])
        for manifest in (value.get("prepared_manifests") or {}).values():
            for item in manifest.get("resources") or []:
                try:
                    await client.create_domain_data_grant(local_domain, str(item.get("engine_input_id")), peer_domain)
                except Exception as exc:
                    if "exist" not in str(exc).lower():
                        raise
        if prepare_only:
            value["status"] = "accepted"
            self.save(run_id, connector_id, value)
            return value
        if request.get("dispatch_connector_id") != connector_id:
            value["status"] = "accepted"; self.save(run_id, connector_id, value); return value
        if peer_prepared:
            expected_peer = request.get("consumer_connector_id") if request.get("provider_connector_id") == connector_id else request.get("provider_connector_id")
            value["peer_manifests"] = _validate_peer_bundle(
                peer_prepared, request, str(expected_peer or ""), peer_domain, run_id
            )
            value["peer_input"] = peer_prepared
            self.save(run_id, connector_id, value)
        own_provider = request.get("provider_connector_id") == connector_id
        provider_domain, consumer_domain = (local_domain, peer_domain) if own_provider else (peer_domain, local_domain)
        connector_domains = {
            str(request.get("provider_connector_id") or ""):provider_domain,
            str(request.get("consumer_connector_id") or ""):consumer_domain,
        }
        manifests = {**(value.get("prepared_manifests") or {}), **(value.get("peer_manifests") or {})}
        job, outputs, images = _compile_job(request, manifests, value["external_run_ref"], connector_domains)
        for image in images:
            definition = image if image.get("image_name") and image.get("image_tag") else database.application_image(str(image.get("name") or ""))
            if not definition:
                raise DomainError(422, f"AppImage {image.get('name')} 缺少可发布定义")
            await client.publish_appimage(definition)
        await client.create_job(job)
        output_values = [value for node in outputs.values() for value in node.values()]
        value.update({"submitted": True, "status": "running", "job": job, "outputs": outputs,
                      "output_ref": output_values[0].get("resource_ref") if len(output_values) == 1 else None,
                      "output_uri": output_values[0]["relative_uri"].removeprefix("/home/kuscia/var/storage/data/") if len(output_values) == 1 else None,
                      "output_format": output_values[0]["format"] if len(output_values) == 1 else None}); self.save(run_id, connector_id, value); return value

    async def sync(self, run_id: str, connector_id: str, profile: dict[str, Any]) -> dict[str, Any]:
        value = self.get(run_id, connector_id)
        if not value: raise DomainError(404, "本地没有执行记录")
        if not value.get("submitted"): return value
        status = await LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"]).query_job(value["external_run_ref"])
        state = str((status.get("status") or {}).get("state") or status.get("state") or "RUNNING").lower()
        value["status"] = "succeeded" if state in {"succeeded", "finished"} else "failed" if state in {"failed", "cancelled", "canceled", "approvalreject"} else "running"; value["kuscia_status"] = status; self.save(run_id, connector_id, value); return value
