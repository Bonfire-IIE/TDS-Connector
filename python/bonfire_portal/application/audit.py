from __future__ import annotations

"""Connector-local audit projection stored in the Portal SQLite database."""

from typing import Any

from ..config import Settings
from ..infrastructure.database import Database
from ..infrastructure.platform import PlatformClient


class AuditService:
    _SCOPE = "audit_mirror"

    def __init__(self, settings: Settings, database: Database):
        self.settings, self.database = settings, database

    def mirror(self, connector_id: str) -> dict[str, Any]:
        value = self.database.durable_read(self._SCOPE, connector_id)
        return value if isinstance(value, dict) else {"cursor": None, "events": []}

    async def sync(self, connector_id: str, authorization: str | None) -> dict[str, Any]:
        current = self.mirror(connector_id)
        value = await PlatformClient(self.settings, authorization).sync_audit(
            connector_id, current.get("cursor")
        )
        value = value if isinstance(value, dict) else {}
        old = current.get("events") if isinstance(current.get("events"), list) else []
        known = {
            item.get("event_id") for item in old
            if isinstance(item, dict) and item.get("event_id")
        }
        incoming = value.get("events") if isinstance(value.get("events"), list) else []
        events = old + [
            item for item in incoming
            if isinstance(item, dict) and item.get("event_id") not in known
        ]
        cursor = value.get("next_cursor")
        self.database.durable_write(
            self._SCOPE,
            connector_id,
            {"cursor": cursor, "events": events},
            state="synced",
        )
        return {"count": value.get("count", len(incoming)), "cursor": cursor}
