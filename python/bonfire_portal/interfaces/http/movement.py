from __future__ import annotations

"""HTTP transport adapter for data movement and compute-input extraction."""

from typing import Any, Callable

from fastapi import Request

from ...application.data_movement import DataMovementService


class MovementHttpAdapter:
    def __init__(self, service: DataMovementService,
                 connector_id: Callable[[Request], str]):
        self.service = service
        self.connector_id = connector_id

    async def transfer_preview(self, request: Request, kind: str | None = None) -> dict[str, Any]:
        return self.service.transfer_preview(await request.json(), self.connector_id(request), kind)

    async def transfer_form(self, request: Request) -> dict[str, Any]:
        return await self.service.transfer_form(self.connector_id(request))

    async def extraction_options(self, request: Request) -> dict[str, Any]:
        return self.service.extraction_options(self.connector_id(request))

    async def prepare_extraction(self, request: Request) -> dict[str, Any]:
        return self.service.prepare_extraction(await request.json(), self.connector_id(request))

    async def prepare_typed_extraction(self, request: Request, kind: str) -> dict[str, Any]:
        return self.service.prepare_typed_extraction(
            await request.json(), kind, self.connector_id(request)
        )

    async def run_extraction(self, request: Request) -> dict[str, Any]:
        body = await request.json()
        return self.service.run_extraction(
            str(body.get("extraction_id") or ""), self.connector_id(request)
        )

    def list_extractions(self, request: Request) -> list[dict[str, Any]]:
        return self.service.list_extractions(self.connector_id(request))

    def get_extraction(self, request: Request, extraction_id: str) -> dict[str, Any]:
        return self.service.get_extraction(extraction_id, self.connector_id(request))

    async def extraction_action(self, request: Request, extraction_id: str,
                                action: str) -> dict[str, Any]:
        return await self.service.extraction_action(extraction_id, action, self.connector_id(request))

    async def complete_extraction(self, request: Request, extraction_id: str) -> dict[str, Any]:
        return self.service.complete_extraction(
            extraction_id, (await request.json()).get("files"), self.connector_id(request)
        )

    async def create_transfer(self, request: Request, request_key: str | None,
                              kind: str | None = None) -> dict[str, Any]:
        body = await request.json()
        return self.service.create_transfer(
            body, request_key or str(body.get("request_key") or ""), self.connector_id(request), kind
        )

    def list_transfers(self, request: Request) -> list[dict[str, Any]]:
        return self.service.list_transfers(self.connector_id(request))

    def get_transfer(self, request: Request, transfer_id: str) -> dict[str, Any]:
        return self.service.get_transfer(transfer_id, self.connector_id(request))

    def list_movements(self, request: Request, channel: str) -> list[dict[str, Any]]:
        return self.service.list_movements(channel, self.connector_id(request))

    async def run_transfer(self, request: Request, transfer_id: str) -> dict[str, Any]:
        return self.service.run_transfer(transfer_id, self.connector_id(request))
