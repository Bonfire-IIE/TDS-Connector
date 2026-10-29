from __future__ import annotations

"""HTTP transport adapter for Portal operational read models."""

from typing import Any, Callable

from fastapi import Request

from ...application.operations import OperationsService


class OperationsHttpAdapter:
    def __init__(self, service: OperationsService,
                 connector_id: Callable[[Request], str],
                 authorization: Callable[[Request], str | None]):
        self.service, self.connector_id, self.authorization = service, connector_id, authorization

    async def overview(self, request: Request) -> dict[str, Any]:
        return await self.service.overview(self.connector_id(request), getattr(request.state, "username", None))

    async def routes(self, request: Request) -> list[dict[str, Any]]:
        return await self.service.routes(self.connector_id(request))

    async def delete_route(self, request: Request, destination: str) -> str:
        return await self.service.delete_route(self.connector_id(request), destination)

    async def projects(self, request: Request) -> Any:
        return await self.service.projects(self.connector_id(request), self.authorization(request))

    async def project(self, request: Request, project_id: str) -> Any:
        self.connector_id(request)
        return await self.service.project(project_id, self.authorization(request))

    async def job_log(self, request: Request, job_id: str, task_id: str | None) -> Any:
        return await self.service.job_log(self.connector_id(request), job_id, task_id)
