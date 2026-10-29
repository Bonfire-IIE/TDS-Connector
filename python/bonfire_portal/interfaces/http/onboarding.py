from __future__ import annotations

"""HTTP transport adapter for connector identity onboarding."""

from typing import Any

from fastapi import Request

from ...application.onboarding import OnboardingService


class OnboardingHttpAdapter:
    def __init__(self, service: OnboardingService):
        self.service = service

    async def state_view(self, request: Request, authorization: str | None) -> dict[str, Any]:
        return await self.service.state_view(authorization, str(request.app.state.connector_id or ""))

    async def connectors(self, authorization: str | None) -> Any:
        return await self.service.connectors(authorization)

    async def identity(self, authorization: str | None) -> dict[str, Any]:
        return await self.service.identity(authorization)

    async def register(self, body: dict[str, Any], authorization: str | None) -> dict[str, Any]:
        return await self.service.register(body, authorization)

    async def upload_certs(self, body: dict[str, Any], authorization: str | None) -> dict[str, Any]:
        return await self.service.upload_certs(body, authorization)

    async def discover(self, request: Request, connector_id: str | None,
                       authorization: str | None) -> dict[str, Any]:
        return await self.service.discover(
            connector_id, str(request.query_params.get("lite_kuscia_endpoint") or ""), authorization
        )

    async def finalize(self, body: dict[str, Any], authorization: str | None) -> dict[str, Any]:
        return await self.service.finalize(body, authorization)
