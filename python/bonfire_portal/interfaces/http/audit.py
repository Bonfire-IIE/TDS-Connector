from __future__ import annotations

from typing import Any, Callable

from fastapi import Request

from ...application.audit import AuditService


class AuditHttpAdapter:
    def __init__(self, service: AuditService, connector_id: Callable[[Request], str],
                 authorization: Callable[[Request], str | None]):
        self.service, self.connector_id, self.authorization = service, connector_id, authorization

    def mirror(self, request: Request) -> dict[str, Any]:
        return self.service.mirror(self.connector_id(request))

    async def sync(self, request: Request) -> dict[str, Any]:
        return await self.service.sync(self.connector_id(request), self.authorization(request))
