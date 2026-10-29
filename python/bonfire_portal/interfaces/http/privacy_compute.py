from __future__ import annotations

"""HTTP transport adapter for privacy-compute engine integration."""

from typing import Any, Callable

from fastapi import Request

from ...application.privacy_compute import PrivacyComputeService


class PrivacyComputeHttpAdapter:
    def __init__(self, service: PrivacyComputeService,
                 connector_id: Callable[[Request], str],
                 authorization: Callable[[Request], str | None],
                 engine_config: Callable[[Request], tuple[str, str, str, dict[str, Any] | None]]):
        self.service = service
        self.connector_id = connector_id
        self.authorization = authorization
        self.engine_config = engine_config

    async def state_view(self, request: Request) -> dict[str, Any]:
        domain, endpoint, cert_dir, profile = self.engine_config(request)
        return await self.service.state_view(
            self.connector_id(request), domain, endpoint, cert_dir, profile
        )

    async def provision(self, request: Request) -> dict[str, Any]:
        body = await request.json()
        return await self.service.provision(
            self.connector_id(request), body.get("implementation_ref"), self.authorization(request)
        )

    async def deploy_script(self, request: Request) -> dict[str, Any]:
        return self.service.deploy_script(await request.json())

    async def activate(self, request: Request) -> dict[str, Any]:
        return await self.service.activate(
            self.connector_id(request), await request.json(), self.authorization(request)
        )
