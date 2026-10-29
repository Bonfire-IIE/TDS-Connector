from __future__ import annotations

import json
from typing import Any

from .database import Database


def _empty() -> dict[str, Any]:
    return {"version": 2, "connectors": {}, "pending_by_user": {}, "selected_by_user": {}}


class PortalState:
    def __init__(self, database: Database):
        self.database = database

    def load(self) -> dict[str, Any]:
        row = self.database.connection().execute("SELECT payload FROM portal_state WHERE id=1").fetchone()
        if not row:
            value = _empty(); self.save(value); return value
        try:
            return json.loads(row["payload"])
        except (TypeError, ValueError):
            return _empty()

    def save(self, value: dict[str, Any]) -> dict[str, Any]:
        self.database.connection().execute(
            "INSERT INTO portal_state(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            (json.dumps(value, ensure_ascii=True),),
        )
        return value

    def profiles(self, username: str) -> list[dict[str, Any]]:
        return [p for p in self.load()["connectors"].values() if p.get("owner_username") == username]

    def selected(self, username: str) -> dict[str, Any] | None:
        state = self.load(); selected = state["selected_by_user"].get(username)
        return state["connectors"].get(selected) if selected else (self.profiles(username) or [None])[0]

    def profile(self, connector_id: str) -> dict[str, Any] | None:
        value = self.load().get("connectors", {}).get(connector_id)
        return value if isinstance(value, dict) else None

    def only_profile(self) -> dict[str, Any] | None:
        profiles = list(self.load().get("connectors", {}).values())
        return profiles[0] if len(profiles) == 1 and isinstance(profiles[0], dict) else None

    def pending(self, username: str) -> dict[str, Any] | None:
        return self.load()["pending_by_user"].get(username)

    def save_pending(self, username: str, pending: dict[str, Any]) -> None:
        state = self.load(); state["pending_by_user"][username] = pending; self.save(state)

    def clear_pending(self, username: str) -> None:
        state = self.load(); state["pending_by_user"].pop(username, None); self.save(state)

    def save_profile(self, username: str, profile: dict[str, Any]) -> None:
        state = self.load(); connector_id = profile["connector_id"]
        state["connectors"][connector_id] = {**profile, "owner_username": username}
        state["selected_by_user"][username] = connector_id; self.save(state)

    def remove_profile(self, username: str, connector_id: str) -> None:
        state = self.load()
        profile = state["connectors"].get(connector_id)
        if isinstance(profile, dict) and profile.get("owner_username") == username:
            state["connectors"].pop(connector_id, None)
        if state["selected_by_user"].get(username) == connector_id:
            state["selected_by_user"].pop(username, None)
        self.save(state)

    def has_any_profile(self) -> bool:
        return bool(self.load()["connectors"])
