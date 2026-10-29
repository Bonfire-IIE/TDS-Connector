from __future__ import annotations

import json
from typing import Any, Callable
from urllib.parse import quote

from fastapi import Request
from fastapi.responses import Response, StreamingResponse

from ...application.node_operations import NodeOperationsService


class NodeHttpAdapter:
    def __init__(self, service: NodeOperationsService,
                 connector_id: Callable[[Request], str]):
        self.service, self.connector_id = service, connector_id

    async def status(self, request: Request) -> dict[str, Any]:
        return await self.service.status(self.connector_id(request))

    async def files(self, request: Request, path: str) -> dict[str, Any]:
        return await self.service.files(self.connector_id(request), path)

    async def upload(self, request: Request, path: str, filename: str | None) -> dict[str, Any]:
        return await self.service.upload(
            self.connector_id(request), path, filename or "", await request.body()
        )

    async def mkdir(self, request: Request, body: dict[str, Any]) -> Any:
        return await self.service.mkdir(self.connector_id(request), str(body.get("path") or ""))

    async def delete(self, request: Request, body: dict[str, Any]) -> str:
        return await self.service.delete(
            self.connector_id(request), str(body.get("path") or ""), bool(body.get("recursive"))
        )

    async def rename(self, request: Request, body: dict[str, Any]) -> Any:
        return await self.service.rename(
            self.connector_id(request),
            str(body.get("source") or ""),
            str(body.get("destination") or ""),
        )

    async def ticket(self, request: Request, body: dict[str, Any]) -> dict[str, Any]:
        return self.service.create_download_ticket(
            self.connector_id(request), str(body.get("path") or "")
        )

    async def download(self, ticket: str):
        content, content_type, filename = await self.service.download(ticket)
        return Response(content=content, media_type=content_type or "application/octet-stream",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"})

    async def log_files(self, request: Request) -> dict[str, Any]:
        return await self.service.log_files(self.connector_id(request), request.query_params.get("kind"))

    async def log_tail(self, request: Request, path: str, lines: int, keyword: str | None) -> dict[str, Any]:
        return await self.service.log_tail(self.connector_id(request), path, lines, keyword)

    async def log_download(self, request: Request, path: str, lines: int) -> StreamingResponse:
        value = await self.service.log_download(self.connector_id(request), path, lines)
        return StreamingResponse(iter([value]), media_type="text/plain")

    async def log_stream(self, request: Request, path: str, lines: int, keyword: str | None) -> StreamingResponse:
        async def events():
            async for batch in self.service.log_stream(
                self.connector_id(request), path, lines, keyword
            ):
                if await request.is_disconnected():
                    break
                yield "data: " + json.dumps({"lines": batch}) + "\n\n"
            yield "event: end\ndata: {}\n\n"
        return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no-cache"})
