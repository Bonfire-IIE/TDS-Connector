from __future__ import annotations

from typing import Any, Callable

from fastapi import Request

from ...application.resource import ResourceService


class ResourceHttpAdapter:
    def __init__(self, resources: ResourceService,
                 connector_id: Callable[[Request], str], authorization: Callable[[Request], str | None]):
        self.resources = resources
        self.connector_id, self.authorization = connector_id, authorization

    async def list(self, request: Request) -> list[dict[str, Any]]:
        return await self.resources.list_synced(self.connector_id(request), self.authorization(request))

    async def register(self, request: Request) -> dict[str, Any]:
        return await self.resources.register_from_request(await request.json(), self.connector_id(request))

    async def update(self, request: Request, resource_id: str) -> dict[str, Any]:
        return await self.resources.update_from_request(resource_id, await request.json(), self.connector_id(request))

    async def delete(self, request: Request, resource_id: str) -> str:
        return await self.resources.delete_projected(
            resource_id, self.connector_id(request), self.authorization(request)
        )

    async def publish(self, request: Request, resource_id: str) -> dict[str, Any]:
        return await self.resources.publish(
            resource_id, self.connector_id(request), self.authorization(request)
        )
