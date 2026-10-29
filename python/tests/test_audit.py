from pathlib import Path

from bonfire_portal.application.audit import AuditService
from bonfire_portal.config import Settings
from bonfire_portal.infrastructure.database import Database


def test_audit_mirror_is_stored_in_sqlite(tmp_path: Path):
    database = Database(tmp_path / "portal.sqlite")
    service = AuditService(Settings(portal_data_dir=tmp_path), database)

    database.durable_write(
        "audit_mirror", "connector-a",
        {"cursor": "next", "events": [{"event_id": "event-1"}]},
        "synced",
    )

    assert service.mirror("connector-a") == {
        "cursor": "next", "events": [{"event_id": "event-1"}],
    }
    assert service.mirror("connector-b") == {"cursor": None, "events": []}
