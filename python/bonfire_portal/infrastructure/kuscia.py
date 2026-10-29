from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import ssl
from urllib.parse import urlsplit

import httpx


class KusciaError(Exception):
    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class LiteClient:
    """Small Kuscia Lite adapter; platform code never receives these raw objects."""

    def __init__(self, endpoint: str, cert_dir: str | Path, timeout: float = 15.0):
        self.endpoint = endpoint.rstrip("/")
        directory = Path(cert_dir)
        self.cert_dir = directory
        self.cert = (str(directory / "kusciaapi-server.crt"), str(directory / "kusciaapi-server.key"))
        # Kuscia's generated API certificate is CA-pinned but commonly only
        # carries localhost/127.0.0.1 in SAN.  Connector deployments may
        # reach the same node through a Docker gateway or private IP.  Keep
        # CA verification and client mTLS, while allowing that deployment
        # address mismatch; an attacker still needs the pinned Kuscia CA.
        self.verify = ssl.create_default_context(cafile=str(directory / "ca.crt"))
        self.verify.check_hostname = False
        self.token = (directory / "token").read_text().strip()
        self.timeout = timeout

    async def request(self, method: str, path: str, payload: Any = None, timeout: float | None = None, params: dict[str, Any] | None = None) -> Any:
        headers = {"Token": self.token, "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(verify=self.verify, cert=self.cert, trust_env=False,
                                         timeout=timeout or self.timeout) as client:
                response = await client.request(method, f"{self.endpoint}/{path.lstrip('/')}",
                                                json=payload, params=params, headers=headers)
        except (OSError, httpx.HTTPError) as exc:
            raise KusciaError(f"Kuscia Lite 不可达: {exc}") from exc
        try:
            data = response.json()
        except ValueError:
            raise KusciaError(f"Kuscia Lite 返回非 JSON ({response.status_code})", response.status_code)
        if response.status_code >= 400:
            raise KusciaError(str(data.get("message") or data.get("detail") or data), response.status_code)
        status = data.get("status") if isinstance(data, dict) else None
        if isinstance(status, dict) and status.get("code") not in (None, 0):
            raise KusciaError(str(status.get("message") or "Kuscia API error"))
        return data

    async def query_domain(self, domain_id: str) -> dict[str, Any]:
        return await self.request("POST", "/api/v1/domain/query", {"domain_id": domain_id})

    async def node_online(self, domain_id: str) -> bool:
        value = await self.query_domain(domain_id)
        data = value.get("data") or {}
        statuses = data.get("node_statuses") or []
        return any(str(item.get("status", "")).lower() in {"online", "ready"} for item in statuses if isinstance(item, dict))

    async def query_domain_data(self, domain_id: str, data_id: str) -> dict[str, Any]:
        value = await self.request("POST", "/api/v1/domaindata/query", {"data": {"domain_id": domain_id, "domaindata_id": data_id}})
        return value.get("data") or {}

    async def create_domain_data(self, *, domain_id: str, data_id: str, name: str, relative_uri: str,
                                 columns: list[dict[str, Any]], datasource_id: str,
                                 attributes: dict[str, Any] | None = None, data_type: str = 'table') -> Any:
        if data_type not in {'table', 'file'}: raise KusciaError('Unsupported DomainData type')
        aliases = {"string": "str", "boolean": "bool", "tinyint": "int8", "smallint": "int16", "int": "int32",
                   "integer": "int64", "bigint": "int64", "float": "float32", "double": "float64", "bytes": "bytes",
                   "date": "str", "time": "str", "timestamp": "str", "timestamp_tz": "str"}
        mapped = []
        for column in columns:
            source_type = str(column.get("type") or "string").lower()
            target_type = "float64" if source_type.startswith("decimal(") else aliases.get(source_type)
            if not target_type: raise KusciaError(f"Kuscia adapter 不支持列类型: {source_type}")
            mapped.append({**column, "type": target_type})
        return await self.request("POST", "/api/v1/domaindata/create", {
            "domain_id": domain_id, "domaindata_id": data_id, "name": name,
            "type": data_type, "relative_uri": relative_uri, "columns": mapped, "datasource_id": datasource_id,
            "attributes": {str(key): str(value) for key, value in (attributes or {}).items()}, "vendor": "bonfire",
        })

    async def create_domain_data_grant(self, owner_domain_id: str, data_id: str, grantee_domain_id: str) -> Any:
        return await self.request("POST", "/api/v1/domaindatagrant/create", {
            "domain_id": owner_domain_id, "domaindata_id": data_id, "grant_domain": grantee_domain_id,
        })

    async def delete_domain_data(self, domain_id: str, data_id: str) -> Any:
        return await self.request("POST", "/api/v1/domaindata/delete", {
            "domain_id": domain_id, "domaindata_id": data_id,
        })

    async def create_job(self, job: dict[str, Any]) -> Any:
        return await self.request("POST", "/api/v1/job/create", job)

    async def query_job(self, job_id: str) -> dict[str, Any]:
        value = await self.request("POST", "/api/v1/job/query", {"job_id": job_id})
        return value.get("data") or value

    async def task_quiescence(self, task_ids: list[str]) -> dict[str, Any]:
        value=await self.request('POST','/api/v1/job/quiescence',{'task_ids':task_ids})
        return value.get('data') or {}

    async def create_route(self, local_domain_id: str, peer_domain_id: str, host: str, port: int, tls: bool = False) -> Any:
        existing = await self.query_route(local_domain_id, peer_domain_id)
        existing_ports = ((existing or {}).get("endpoint") or {}).get("ports") or []
        existing_port = existing_ports[0] if existing_ports else {}
        endpoint_matches = (
            ((existing or {}).get("endpoint") or {}).get("host") == host
            and int(existing_port.get("port") or 0) == port
            and bool(existing_port.get("isTLS")) is tls
        )
        if endpoint_matches:
            return existing
        if existing:
            await self.delete_route(local_domain_id, peer_domain_id)
        return await self.request("POST", "/api/v1/route/create", {"source": local_domain_id, "destination": peer_domain_id,
            "authentication_type": "Token", "endpoint": {"host": host, "ports": [{"name": "http", "port": port, "protocol": "HTTP", "isTLS": tls}]},
            "token_config": {"token_gen_method": "RSA-GEN"}})

    async def query_route(self, local_domain_id: str, peer_domain_id: str) -> dict[str, Any] | None:
        try:
            value = await self.request("POST", "/api/v1/route/query", {
                "source": local_domain_id, "destination": peer_domain_id,
            })
            return value.get("data") or None
        except KusciaError as exc:
            message = str(exc).lower()
            if "not found" in message or "not exist" in message:
                return None
            raise

    async def delete_route(self, local_domain_id: str, peer_domain_id: str) -> None:
        try:
            await self.request("POST", "/api/v1/route/delete", {
                "source": local_domain_id, "destination": peer_domain_id,
            })
        except KusciaError as exc:
            message = str(exc).lower()
            if "not found" not in message and "not exist" not in message:
                raise

    async def create_domain_datasource(self, domain_id: str, datasource_id: str, path: str) -> Any:
        return await self.request("POST", "/api/v1/domaindatasource/create", {"domain_id": domain_id,
            "datasource_id": datasource_id, "type": "localfs", "name": "Bonfire staging workspace",
            "info": {"localfs": {"path": path}}, "access_directly": True})

    async def ensure_partner_domain(self, domain_id: str, certificate: str, *, allow_certificate_update: bool = False) -> Any:
        try: return await self.request("POST", "/api/v1/domain/create", {"domain_id": domain_id, "role": "partner", "cert": certificate})
        except KusciaError as exc:
            if "exist" not in str(exc).lower(): raise
            current = (await self.query_domain(domain_id)).get("data") or {}
            if current.get("cert") and current.get("cert") != certificate and not allow_certificate_update:
                raise KusciaError("对端 Domain 证书发生变化，需要显式更新信任配置")
            if current.get("cert") != certificate:
                return await self.request("POST", "/api/v1/domain/update", {"domain_id": domain_id, "role": "partner", "cert": certificate,
                    "auth_center": current.get("auth_center"), "master_domain_id": current.get("master_domain_id")})

    async def publish_appimage(self, app: dict[str, Any]) -> Any:
        templates = []
        for value in app.get("deploy_templates") or []:
            spec = value.get("spec") if isinstance(value.get("spec"), dict) else value
            templates.append({"name": value.get("name"), "role": value.get("role"), "replicas": value.get("replicas", 1),
                "restart_policy": spec.get("restart_policy", "Never"), "containers": spec.get("containers") or []})
        payload = {"name": app["name"], "image": {"name": app["image_name"], "tag": app["image_tag"]},
                   "deploy_templates": templates, "config_templates": app.get("config_templates") or {}}
        try: return await self.request("POST", "/api/v1/appimage/create", payload)
        except KusciaError as exc:
            if "exist" not in str(exc).lower(): raise
            return await self.request("POST", "/api/v1/appimage/update", payload)

    async def ftp_request(self, method: str, suffix: str = "", payload: Any = None, timeout: float = 120.0) -> Any:
        return await self.request(method, f"/api/v1/ftp/sessions{suffix}", payload, timeout)

    async def _legacy_file_context(self) -> tuple[str, str, str, str]:
        """Discover the file-service Serving shipped by older Kuscia bundles.

        New Kuscia builds expose `/api/v1/file/*` directly.  The bundle used by
        existing deployments instead schedules a `file-service-<domain>`
        Serving and exposes it through the domain gateway.  Keeping discovery
        here makes the rest of the portal independent of that deployment
        detail and avoids asking operators to copy a generated token into the
        portal configuration.
        """
        domain = self.cert_dir.parent.name
        serving = await self.request("POST", "/api/v1/serving/query", {
            "serving_id": f"file-service-{domain}"
        })
        data = serving.get("data") or {}
        config = data.get("serving_input_config") or "{}"
        try:
            token = str(json.loads(config).get("token") or "")
        except (TypeError, ValueError):
            token = ""
        parties = data.get("parties") or []
        prefix = str((parties[0] if parties else {}).get("service_name_prefix") or f"filesvc-{domain}")
        endpoint = ""
        party_statuses = (data.get("status") or {}).get("party_statuses") or []
        for item in (party_statuses[0] if party_statuses else {}).get("endpoints", []) or []:
            if str(item.get("port_name") or "") == "http":
                endpoint = str(item.get("endpoint") or "")
                break
        service_host = endpoint.rsplit(":", 1)[0] if ":" in endpoint else f"{prefix}-http.{domain}.svc"
        parsed = urlsplit(self.endpoint)
        # Kuscia Docker deployments map container 8082 (Lite API) to the
        # host's API port and container 80 (the domain gateway used for
        # Serving routes) two ports above it, e.g. 28081 -> 28083.
        gateway_port = parsed.port + 2 if parsed.port else 80
        gateway = f"http://{parsed.hostname or '127.0.0.1'}:{gateway_port}"
        if not token:
            raise KusciaError("Kuscia file-service Serving 未返回访问令牌")
        return gateway, service_host, domain, token

    async def _legacy_file_request(self, method: str, path: str, *, params: dict[str, Any] | None = None,
                                   content: bytes | None = None, content_type: str | None = None) -> tuple[httpx.Response, str]:
        gateway, service_host, domain, token = await self._legacy_file_context()
        headers = {"Content-Type": content_type or "application/octet-stream",
                   "Authorization": f"Bearer {token}",
                   "Host": service_host, "Kuscia-Source": domain}
        async with httpx.AsyncClient(timeout=120.0, trust_env=False) as client:
            response = await client.request(method, f"{gateway}{path}", params=params,
                                             content=content, headers=headers)
        if response.status_code >= 400:
            raise KusciaError(f"Kuscia file-service 返回 HTTP {response.status_code}", response.status_code)
        return response, gateway

    async def file_request(self, method: str, path: str = "", payload: Any = None) -> Any:
        try:
            return await self.request(method, f"/api/v1/file{path}", payload)
        except KusciaError as exc:
            if exc.status_code != 404:
                raise
            legacy_path = {"/healthz": "/healthz", "/list": "/api/v1/files",
                           "/content": "/api/v1/files/content", "/mkdir": "/api/v1/files/mkdir",
                           "/delete": "/api/v1/files/delete", "/rename": "/api/v1/files/rename"}.get(path)
            if legacy_path is None:
                raise
            response, _ = await self._legacy_file_request(method, legacy_path,
                                                          content=json.dumps(payload).encode() if payload is not None else None,
                                                          content_type="application/json" if payload is not None else None)
            try: return response.json()
            except ValueError: raise KusciaError(f"Kuscia file-service 返回非 JSON ({response.status_code})", response.status_code)

    async def list_files(self, relative_path: str = "") -> Any:
        try:
            return await self.request("GET", "/api/v1/file/list", params={"path": relative_path} if relative_path else None)
        except KusciaError as exc:
            if exc.status_code != 404:
                raise
            response, _ = await self._legacy_file_request("GET", "/api/v1/files",
                                                          params={"path": relative_path})
            try: return response.json()
            except ValueError: raise KusciaError(f"Kuscia file-service 返回非 JSON ({response.status_code})", response.status_code)

    async def mkdir_file(self, relative_path: str) -> Any:
        return await self.file_request("POST", "/mkdir", {"path": relative_path})

    async def delete_file(self, relative_path: str, recursive: bool = False) -> Any:
        return await self.file_request("POST", "/delete", {"path": relative_path, "recursive": recursive})

    async def rename_file(self, source: str, destination: str) -> Any:
        return await self.file_request("POST", "/rename", {"source": source, "destination": destination})

    async def file_health(self) -> Any:
        return await self.file_request("GET", "/healthz")

    async def upload_file(self, directory: str, filename: str, content: bytes) -> Any:
        headers = {"Token": self.token, "Content-Type": "application/octet-stream"}
        try:
            async with httpx.AsyncClient(verify=self.verify, cert=self.cert, trust_env=False, timeout=120.0) as client:
                response = await client.put(f"{self.endpoint}/api/v1/file", params={"path": directory, "filename": filename}, content=content, headers=headers)
            response.raise_for_status(); return response.json()
        except (OSError, httpx.HTTPError, ValueError) as exc:
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404:
                response, _ = await self._legacy_file_request("PUT", "/api/v1/files",
                    params={"path": directory, "filename": filename}, content=content)
                try: return response.json()
                except ValueError: return {"status": {"code": 0}, "data": {"path": f"{directory.rstrip('/')}/{filename}"}}
            raise KusciaError(f"Kuscia 文件上传失败: {exc}") from exc

    async def download_file(self, relative_path: str) -> tuple[bytes, str | None]:
        headers = {"Token": self.token}
        try:
            async with httpx.AsyncClient(verify=self.verify, cert=self.cert, trust_env=False, timeout=120.0) as client:
                response = await client.get(f"{self.endpoint}/api/v1/file/content", params={"path": relative_path}, headers=headers)
            response.raise_for_status(); return response.content, response.headers.get("content-type")
        except (OSError, httpx.HTTPError) as exc:
            if isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 404:
                response, _ = await self._legacy_file_request("GET", "/api/v1/files/content", params={"path": relative_path})
                return response.content, response.headers.get("content-type")
            raise KusciaError(f"Kuscia 文件下载失败: {exc}") from exc

    async def list_node_log_files(self, kind: str | None = None) -> Any:
        value = await self.request("POST", "/api/v1/log/node/files", {"kind": kind or ""})
        return value.get("data", value)

    async def stream_node_log(self, path: str, tail_lines: int, follow: bool, keyword: str | None = None):
        headers = {"Token": self.token, "Content-Type": "application/json"}
        decoder = json.JSONDecoder(); buffer = ""
        try:
            async with httpx.AsyncClient(verify=self.verify, cert=self.cert, trust_env=False, timeout=None) as client:
                async with client.stream("POST", f"{self.endpoint}/api/v1/log/node/log/query",
                    json={"path": path, "tail_lines": tail_lines, "follow": follow, "keyword": keyword or ""}, headers=headers) as response:
                    response.raise_for_status()
                    async for text in response.aiter_text():
                        buffer += text
                        while buffer:
                            stripped = buffer.lstrip()
                            try: value, end = decoder.raw_decode(stripped)
                            except json.JSONDecodeError: break
                            buffer = stripped[end:]
                            status = value.get("status") or {}
                            if status.get("code") not in (None, 0): raise KusciaError(str(status.get("message") or "Kuscia 日志查询失败"))
                            payload = str(value.get("log") or "")
                            if payload: yield payload.splitlines()
        except (OSError, httpx.HTTPError) as exc:
            raise KusciaError(f"Kuscia 日志流失败: {exc}") from exc

    async def read_node_log(self, path: str, tail_lines: int, keyword: str | None = None) -> list[str]:
        result: list[str] = []
        async for lines in self.stream_node_log(path, tail_lines, False, keyword):
            result.extend(lines)
            if len(result) >= 10000: break
        return result[:10000]

    async def query_job_log(self, job_id: str, task_id: str | None = None) -> Any:
        value = await self.request("POST", "/api/v1/log/task/query", {
            "task_id": task_id or job_id,
        })
        return value.get("data", value)
