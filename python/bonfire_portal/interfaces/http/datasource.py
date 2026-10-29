from __future__ import annotations

from typing import Any, Callable

from fastapi import Request

from ...application.datasource import DataSourceApplicationService


class DataSourceHttpAdapter:
    def __init__(self, service: DataSourceApplicationService,
                 connector_id: Callable[[Request], str],
                 publicize: Callable[[dict[str, Any]], dict[str, Any]]):
        self.service = service
        self.connector_id, self.publicize = connector_id, publicize

    def list(self, request: Request) -> list[dict[str, Any]]:
        return self.service.list(self.connector_id(request), self.publicize)

    async def register(self, request: Request) -> dict[str, Any]:
        return self.service.register(await request.json(), self.connector_id(request), self.publicize)

    async def delete(self, request: Request, datasource_id: str) -> str:
        return self.service.delete_registered(datasource_id, self.connector_id(request))
