from __future__ import annotations

"""Browser session use cases backed by the center identity service."""

from typing import Any

from ..config import Settings
from ..infrastructure.platform import PlatformClient


class SessionService:
    def __init__(self, settings: Settings):
        self.settings = settings

    async def login(self, username: str, password: str) -> dict[str, Any]:
        data = await PlatformClient(self.settings, None).login(username, password)
        return {"access_token": data.get("access_token"), "switched": False}

    @staticmethod
    def status(connector_id: str) -> dict[str, Any]:
        return {"connector_id": connector_id}
