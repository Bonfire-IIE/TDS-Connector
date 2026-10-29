from __future__ import annotations

"""Operational read models for the Connector Portal."""

import time
from typing import Any

from ..config import Settings
from ..domain.errors import DomainError
from ..infrastructure.database import Database
from ..infrastructure.kuscia import KusciaError, LiteClient
from ..infrastructure.platform import PlatformClient
from ..infrastructure.state import PortalState
from ..infrastructure.services import ServiceGateway


class OperationsService:
    def __init__(self, settings: Settings, database: Database, state: PortalState,
                 services: ServiceGateway):
        self.settings, self.database, self.state, self.services = settings, database, state, services
        self.started_at = time.monotonic()

    def _profile(self, connector_id: str, required: bool = False) -> dict[str, Any]:
        profile = self.state.profile(connector_id) or {}
        if required and not profile:
            raise DomainError(409, "连接器尚未完成接入")
        return profile

    def _lite(self, connector_id: str) -> tuple[str, LiteClient | None, dict[str, Any]]:
        profile = self._profile(connector_id)
        domain = str(profile.get("domain_id") or "")
        endpoint = str(profile.get("lite_kuscia_endpoint") or "")
        cert_dir = str(profile.get("lite_cert_dir") or "")
        return domain, LiteClient(endpoint, cert_dir) if domain and endpoint and cert_dir else None, profile

    async def overview(self, connector_id: str, username: str | None = None) -> dict[str, Any]:
        domain, lite, profile = self._lite(connector_id)
        online = False
        if lite and domain:
            try:
                online = await lite.node_online(domain)
            except (KusciaError, OSError):
                pass
        import asyncio
        async def count(service, path, field):
            try:
                value = await self.services.json(service, connector_id, 'GET', path, username=username)
                return {'available': True, 'value': len(value['items']) if field == 'items' else value[field]}
            except (DomainError, KeyError, TypeError):
                return {'available': False, 'value': None}
        di, dr, ts = await asyncio.gather(count('di', '/api/v1/datasources', 'items'),
                                        count('dr', '/api/v1/resources?limit=1', 'total'),
                                        count('ts', '/api/v1/admin/summary', 'objects'))
        return {
            "services": {'di': di, 'dr': dr, 'ts': ts},
            "connector_id": connector_id,
            "privacy_compute_configured": bool(domain),
            "online": online,
            "datasource_count": di["value"],
            "resource_count": dr["value"],
            "uptime_seconds": int(time.monotonic() - self.started_at),
            "privacy_compute_endpoint": profile.get("lite_kuscia_endpoint"),
        }

    async def routes(self, connector_id: str) -> list[dict[str, Any]]:
        domain, lite, _ = self._lite(connector_id)
        if not domain or not lite:
            return []
        result = []
        for item in self.database.durable_list("route"):
            if item.get("source") != domain or item.get("local_connector_id", connector_id) != connector_id:
                continue
            destination = str(item.get("destination") or "")
            route = await lite.query_route(domain, destination)
            status = (route or {}).get("status") or {}
            result.append({
                **item,
                "status": status.get("status") if isinstance(status, dict) else status,
                "details": route,
            })
        return result

    async def delete_route(self, connector_id: str, destination: str) -> str:
        domain, lite, _ = self._lite(connector_id)
        if not domain or not lite:
            raise DomainError(409, "隐私计算引擎尚未配置")
        await lite.delete_route(domain, destination)
        self.database.durable_delete("route", f"{connector_id}:{destination}")
        # Remove a pre-migration key only when it belongs to this local Domain.
        legacy = self.database.durable_read("route", destination)
        if legacy and legacy.get("source") == domain:
            self.database.durable_delete("route", destination)
        return destination

    async def projects(self, connector_id: str, authorization: str | None) -> Any:
        return await PlatformClient(self.settings, authorization).list_projects(connector_id)

    async def project(self, project_id: str, authorization: str | None) -> Any:
        return await PlatformClient(self.settings, authorization).get_project(project_id)

    async def job_log(self, connector_id: str, job_id: str, task_id: str | None) -> Any:
        _, lite, _ = self._lite(connector_id)
        if not lite:
            raise DomainError(409, "隐私计算引擎尚未配置")
        return await lite.query_job_log(job_id, task_id)
