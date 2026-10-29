from __future__ import annotations

from typing import Any, Callable

from fastapi import Request

from ...application.appimage import ApplicationImageService
class AppImageHttpAdapter:
    def __init__(self, service: ApplicationImageService, connector_id: Callable[[Request], str]):
        self.service, self.connector_id = service, connector_id

    async def register(self, request: Request) -> dict[str, Any]:
        return await self.service.register_and_publish(await request.json(), self.connector_id(request))

    def list(self, request: Request) -> list[dict[str, Any]]:
        return self.service.list(self.connector_id(request))
