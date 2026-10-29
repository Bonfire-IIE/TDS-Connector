from __future__ import annotations

"""Kuscia-backed file and node-log operations.

Connector-local source browsing belongs to the data catalog.  This service is
only available after the connector has activated a Kuscia engine.
"""

import os
import secrets
import time
from pathlib import Path
from typing import Any, AsyncIterator

from ..config import Settings
from ..domain.errors import DomainError
from ..infrastructure.kuscia import KusciaError, LiteClient
from ..infrastructure.state import PortalState


class NodeOperationsService:
    def __init__(self, settings: Settings, state: PortalState):
        self.settings, self.state = settings, state
        self._tickets: dict[str, dict[str, Any]] = {}

    def _engine(self, connector_id: str) -> tuple[str, str, str]:
        profile = self.state.profile(connector_id) or {}
        domain = str(profile.get("domain_id") or os.getenv("PORTAL_DOMAIN_ID", ""))
        endpoint = str(profile.get("lite_kuscia_endpoint") or os.getenv("LITE_KUSCIA_ENDPOINT", ""))
        cert_dir = str(profile.get("lite_cert_dir") or os.getenv(
            "LITE_CERT_DIR",
            str(self.settings.portal_data_dir / "lite" / domain / "certs") if domain else "",
        ))
        return domain, endpoint, cert_dir

    def _lite(self, connector_id: str) -> LiteClient:
        domain, endpoint, cert_dir = self._engine(connector_id)
        if not domain or not endpoint or not cert_dir or not (Path(cert_dir) / "token").is_file():
            raise DomainError(409, "隐私计算引擎尚未配置")
        try:
            return LiteClient(endpoint, cert_dir)
        except (OSError, KusciaError) as exc:
            raise DomainError(409, f"隐私计算引擎配置不可用: {exc}") from exc

    async def status(self, connector_id: str) -> dict[str, Any]:
        try:
            lite = self._lite(connector_id)
            await lite.file_health()
            return {"available": True, "backend": "kuscia", "endpoint": lite.endpoint}
        except (DomainError, KusciaError) as exc:
            return {"available": False, "backend": "kuscia", "message": str(exc)}

    async def files(self, connector_id: str, path: str) -> dict[str, Any]:
        value = await self._lite(connector_id).list_files(path)
        return value.get("data", value)

    async def upload(self, connector_id: str, path: str, filename: str, content: bytes) -> dict[str, Any]:
        if not filename or "/" in filename or "\\" in filename or filename in {".", ".."}:
            raise DomainError(422, "缺少合法文件名")
        value = await self._lite(connector_id).upload_file(path, filename, content)
        return value.get("data", value)

    async def mkdir(self, connector_id: str, path: str) -> Any:
        value = await self._lite(connector_id).mkdir_file(path)
        return value.get("data", value)

    async def delete(self, connector_id: str, path: str, recursive: bool) -> str:
        await self._lite(connector_id).delete_file(path, recursive)
        return path

    async def rename(self, connector_id: str, source: str, destination: str) -> Any:
        value = await self._lite(connector_id).rename_file(source, destination)
        return value.get("data", value) if isinstance(value, dict) else value

    def create_download_ticket(self, connector_id: str, path: str) -> dict[str, Any]:
        if not path:
            raise DomainError(422, "缺少文件路径")
        self._lite(connector_id)
        token = secrets.token_urlsafe(32)
        self._tickets[token] = {
            "path": path,
            "connector_id": connector_id,
            "expires_at": time.time() + 30,
        }
        return {"ticket": token, "expires_in": 30}

    async def download(self, ticket: str) -> tuple[bytes, str, str]:
        grant = self._tickets.pop(ticket, None)
        if not grant or grant["expires_at"] < time.time():
            raise DomainError(401, "下载凭证无效或已过期")
        relative = str(grant["path"])
        content, content_type = await self._lite(str(grant["connector_id"])).download_file(relative)
        return content, content_type or "application/octet-stream", Path(relative).name

    async def log_files(self, connector_id: str, kind: str | None) -> dict[str, Any]:
        return await self._lite(connector_id).list_node_log_files(kind)

    async def log_tail(self, connector_id: str, path: str, lines: int,
                       keyword: str | None) -> dict[str, Any]:
        limit = min(max(lines, 1), 10000)
        values = await self._lite(connector_id).read_node_log(path, limit, keyword)
        return {"path": path, "requested_lines": lines, "truncated": len(values) >= limit, "lines": values}

    async def log_download(self, connector_id: str, path: str, lines: int) -> str:
        values = await self._lite(connector_id).read_node_log(path, min(max(lines, 1), 10000))
        return "\n".join(values)

    async def log_stream(self, connector_id: str, path: str, lines: int,
                         keyword: str | None) -> AsyncIterator[list[str]]:
        async for batch in self._lite(connector_id).stream_node_log(
            path, min(max(lines, 1), 10000), True, keyword
        ):
            yield batch
