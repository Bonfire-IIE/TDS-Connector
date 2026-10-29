from __future__ import annotations

from typing import Any

from fastapi import Request

from ...application.session import SessionService


class SessionHttpAdapter:
    """Browser session endpoints backed by the center identity service."""

    def __init__(self, service: SessionService):
        self.service = service

    async def login(self, body: dict[str, Any]) -> dict[str, Any]:
        return await self.service.login(
            str(body.get("username") or ""), str(body.get("password") or "")
        )

    def status(self, request: Request) -> dict[str, Any]:
        return self.service.status(str(request.app.state.connector_id or ""))
