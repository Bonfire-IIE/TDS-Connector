from __future__ import annotations

from typing import Any
import json
from urllib.parse import urlsplit

import httpx

from ..config import Settings
from ..domain.errors import DomainError
from .execution_auth import execution_headers


class PlatformError(DomainError):
    pass


class PlatformClient:
    def __init__(self, settings: Settings, authorization: str | None):
        self.settings = settings
        self.base = settings.platform_api_base.rstrip("/")
        self.authorization = authorization
        self.timeout = 15.0

    async def request(self, method: str, path: str, body: dict[str, Any] | None = None,
                      params: dict[str, Any] | None = None) -> Any:
        if not self.authorization:
            raise PlatformError(401, "缺少 Authorization 头")
        headers = {"Authorization": self.authorization if self.authorization.lower().startswith("bearer ")
                   else f"Bearer {self.authorization}", "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
                response = await client.request(method, f"{self.base}{path}", json=body, params=params, headers=headers)
        except httpx.HTTPError as exc:
            raise PlatformError(502, f"平台不可达: {exc}") from exc
        try:
            payload = response.json()
        except ValueError:
            payload = {"message": response.text}
        if response.status_code >= 400:
            raise PlatformError(response.status_code, str(payload.get("detail") or payload.get("message") or "平台 API 错误"))
        if isinstance(payload, dict) and "data" in payload:
            if payload.get("code") not in (None, 0):
                raise PlatformError(400, str(payload.get("message") or "平台返回错误"))
            return payload["data"]
        return payload

    async def publish_resource(self, payload: dict[str, Any]) -> Any:
        return await self.request("POST", "/catalog/resources/publish", payload)

    async def list_resources(self, connector_id: str) -> Any:
        return await self.request("GET", "/catalog/resources", params={"connector_id": connector_id})

    async def delete_resource(self, resource_id: str) -> Any:
        return await self.request("DELETE", f"/catalog/resources/{resource_id}")

    async def me(self) -> Any:
        return await self.request("GET", "/identity/me")

    async def login(self, username: str, password: str) -> Any:
        # Login is the one platform call that intentionally has no bearer token.
        headers = {"Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
                response = await client.post(f"{self.base}/identity/login", json={"username": username, "password": password}, headers=headers)
        except httpx.HTTPError as exc:
            raise PlatformError(502, f"平台不可达: {exc}") from exc
        payload = response.json()
        if response.status_code >= 400 or (isinstance(payload, dict) and payload.get("code") not in (None, 0)):
            raise PlatformError(response.status_code if response.status_code >= 400 else 400,
                                str(payload.get("message") or payload.get("detail") or "登录失败"))
        return payload.get("data", payload)

    async def list_connectors(self) -> Any:
        return await self.request("GET", "/connectors")

    async def list_projects(self, connector_id: str) -> Any:
        return await self.request("GET", "/projects", params={"connector_id": connector_id})

    async def get_project(self, project_id: str) -> Any:
        return await self.request("GET", f"/projects/{project_id}")

    async def register_connector(self, body: dict[str, Any]) -> Any:
        return await self.request("POST", "/connectors", body)

    async def get_connector_certificate(self, connector_id: str) -> Any:
        return await self.request("GET", f"/connectors/{connector_id}/certificate")

    async def activate_connector(self, connector_id: str, fingerprint: str) -> Any:
        return await self.request("POST", f"/connectors/{connector_id}/activate",
                                  {"certificate_fingerprint": fingerprint})

    async def provision_privacy_compute(self, connector_id: str, implementation_ref: str | None = None) -> Any:
        return await self.request("POST", f"/capabilities/connectors/{connector_id}/privacy-compute/provision",
                                  {"implementation_ref": implementation_ref})

    async def list_applications(self) -> Any:
        return await self.request("GET", "/capabilities/applications")

    async def declare_capability(self, connector_id: str, body: dict[str, Any]) -> Any:
        return await self.request("POST", f"/capabilities/connectors/{connector_id}", body)

    async def verify_capability(self, connector_id: str, code: str) -> Any:
        return await self.request("POST", f"/capabilities/connectors/{connector_id}/{code}/verify")

    async def execution_run(self, run_id: str, connector_id: str) -> Any:
        return await self.request("GET", f"/privacy-computing/gateway/runs/{run_id}", params={"connector_id": connector_id})

    async def execution_identity(self, run_id: str, connector_id: str, peer_connector_id: str) -> Any:
        return await self.request("GET", f"/privacy-computing/gateway/runs/{run_id}/identity",
                                  params={"connector_id": connector_id, "peer_connector_id": peer_connector_id})

    async def report_execution(self, run_id: str, payload: dict[str, Any]) -> Any:
        return await self.request("POST", f"/privacy-computing/gateway/runs/{run_id}/report", payload)

    async def sync_audit(self, connector_id: str, cursor: str | None = None) -> Any:
        params = {"connector_id": connector_id}
        if cursor: params["cursor"] = cursor
        return await self.request("GET", "/audit/sync", params=params)

    async def machine_execution_identity(self, run_id: str, profile: dict[str, Any], peer_connector_id: str) -> Any:
        path = f"/privacy-computing/gateway/runs/{run_id}/identity"
        params = {"connector_id": profile["connector_id"], "peer_connector_id": peer_connector_id}
        return await self._machine_request("GET", path, profile, params=params)

    async def machine_execution_run(self, run_id: str, profile: dict[str, Any]) -> Any:
        return await self._machine_request("GET", f"/privacy-computing/gateway/runs/{run_id}", profile,
                                           params={"connector_id": profile["connector_id"]})

    async def machine_report_execution(self, run_id: str, profile: dict[str, Any], payload: dict[str, Any]) -> Any:
        return await self._machine_request("POST", f"/privacy-computing/gateway/runs/{run_id}/report", profile, body=payload)

    async def _machine_request(self, method: str, path: str, profile: dict[str, Any], *,
                               body: dict[str, Any] | None = None, params: dict[str, Any] | None = None) -> Any:
        query = httpx.QueryParams(params or {})
        request_url = f"{self.base}{path}"
        parsed = urlsplit(request_url)
        target = parsed.path + (f"?{query}" if query else "")
        raw = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json", **execution_headers(profile, "@center", method, target, raw, self.settings)}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
                response = await client.request(method, request_url, params=params,
                                                content=raw or None, headers=headers)
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc: raise PlatformError(502, f"平台机器身份查询失败: {exc}") from exc
        if response.status_code >= 400: raise PlatformError(response.status_code, str(payload.get("detail") or payload))
        return payload.get("data", payload)
