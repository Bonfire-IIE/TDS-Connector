from __future__ import annotations

"""HTTP transport adapter for Connector execution-gateway use cases."""

from typing import Any, Callable

from fastapi import Request

from ...application.execution_gateway import ExecutionGatewayContext, ExecutionGatewayService


class PrivacyExecutionHttpAdapter:
    def __init__(self, service: ExecutionGatewayService,
                 connector_id: Callable[[Request], str],
                 authorization: Callable[[Request], str | None]):
        self.service = service
        self.connector_id = connector_id
        self.authorization = authorization

    def _context(self, request: Request) -> ExecutionGatewayContext:
        return ExecutionGatewayContext(
            connector_id=self.connector_id(request),
            authorization=self.authorization(request),
            machine_dispatch=bool(getattr(request.state, "machine_dispatch", False)),
            machine_signer=str(getattr(request.state, "machine_signer", "") or ""),
        )

    async def requests(self, request: Request) -> Any:
        return await self.service.requests(self._context(request))

    async def identity(self, request: Request, run_id: str) -> dict[str, Any]:
        return await self.service.identity(self._context(request), run_id)

    async def prepare(self, request: Request, run_id: str) -> dict[str, Any]:
        return await self.service.prepare(self._context(request), run_id, await request.json())

    async def execute(self, request: Request, run_id: str) -> dict[str, Any]:
        return await self.service.execute(self._context(request), run_id, await request.json())

    async def sync(self, request: Request, run_id: str) -> dict[str, Any]:
        return await self.service.sync(self._context(request), run_id)

    async def report(self, request: Request, run_id: str) -> Any:
        return await self.service.report(self._context(request), run_id, await request.json())
