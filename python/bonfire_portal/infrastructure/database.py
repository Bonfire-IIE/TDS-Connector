from __future__ import annotations

import json
import sqlite3
import threading
import datetime
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


MIGRATIONS = [
    """
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS durable_record (
      scope TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
      state TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, key)
    );
    CREATE INDEX IF NOT EXISTS idx_durable_scope_state ON durable_record(scope, state);
    CREATE TABLE IF NOT EXISTS application_image (
      name TEXT PRIMARY KEY, payload TEXT NOT NULL, registered_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS datasource (
      id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_datasource_connector ON datasource(connector_id, created_at DESC);
    """,
    """
    CREATE TABLE IF NOT EXISTS catalog_object (
      datasource_id TEXT NOT NULL, object_ref TEXT NOT NULL, parent_ref TEXT,
      kind TEXT NOT NULL, name TEXT NOT NULL, path TEXT NOT NULL,
      data_kind TEXT, format TEXT, selectable INTEGER NOT NULL DEFAULT 0,
      expandable INTEGER NOT NULL DEFAULT 0, inspectable INTEGER NOT NULL DEFAULT 0,
      transferable INTEGER NOT NULL DEFAULT 0, size INTEGER, modified_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', generation INTEGER NOT NULL,
      indexed_at TEXT NOT NULL, PRIMARY KEY(datasource_id, object_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_parent ON catalog_object(datasource_id, parent_ref, name);
    CREATE TABLE IF NOT EXISTS catalog_index_run (
      id TEXT PRIMARY KEY, datasource_id TEXT NOT NULL, state TEXT NOT NULL,
      generation INTEGER NOT NULL, cursor TEXT, object_count INTEGER NOT NULL DEFAULT 0,
      error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_catalog_run_source ON catalog_index_run(datasource_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS schema_cache (
      datasource_id TEXT NOT NULL, object_ref TEXT NOT NULL, fingerprint TEXT NOT NULL,
      payload TEXT NOT NULL, inspected_at TEXT NOT NULL,
      PRIMARY KEY(datasource_id, object_ref)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_object_fts USING fts5(
      datasource_id UNINDEXED, object_ref UNINDEXED, name, path,
      tokenize='unicode61 remove_diacritics 2'
    );
    """,
    """
    CREATE TABLE IF NOT EXISTS connector_resource (
      id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, payload TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_resource_connector ON connector_resource(connector_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_resource_status ON connector_resource(status);
    """,
    """
    CREATE TABLE IF NOT EXISTS portal_state (
      id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL
    );
    """,
]


class Database:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._local = threading.local()
        self.migrate()

    def connection(self) -> sqlite3.Connection:
        connection = getattr(self._local, "connection", None)
        if connection is None:
            connection = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA busy_timeout=30000")
            self._local.connection = connection
        return connection

    @contextmanager
    def transaction(self, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        connection = self.connection()
        connection.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        try:
            yield connection
            connection.execute("COMMIT")
        except Exception:
            connection.execute("ROLLBACK")
            raise

    def migrate(self) -> None:
        connection = self.connection()
        connection.execute("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        self._migrate_legacy_connector_resource(connection)
        applied = {row[0] for row in connection.execute("SELECT version FROM schema_version")}
        for version, sql in enumerate(MIGRATIONS, start=1):
            if version in applied:
                continue
            with self.transaction(immediate=True) as tx:
                for statement in _statements(sql):
                    tx.execute(statement)
                tx.execute("INSERT INTO schema_version(version) VALUES (?)", (version,))
        self._import_legacy_appimages(connection)

    def _migrate_legacy_connector_resource(self, connection: sqlite3.Connection) -> None:
        """Upgrade the Node portal resource table before indexed migrations run."""
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='connector_resource'"
        ).fetchone()
        if not table:
            return
        columns = {row["name"] for row in connection.execute("PRAGMA table_info(connector_resource)")}
        if "connector_id" in columns:
            return
        if "resource_code" not in columns:
            raise RuntimeError("unsupported connector_resource schema")

        rows = connection.execute(
            "SELECT id,payload,status,created_at,updated_at FROM connector_resource"
        ).fetchall()
        fallback = self._single_profile_connector_id(connection)
        converted: list[tuple[str, str, str, str, str, str]] = []
        for row in rows:
            payload = json.loads(row["payload"])
            connector_id = str(payload.get("connector_id") or fallback or "")
            if not connector_id:
                raise RuntimeError(
                    "legacy connector_resource rows cannot be assigned to a connector; "
                    "bind exactly one connector profile before migration"
                )
            payload["connector_id"] = connector_id
            converted.append((
                row["id"], connector_id, json.dumps(payload, ensure_ascii=True),
                row["status"], row["created_at"], row["updated_at"],
            ))

        with self.transaction(immediate=True) as tx:
            tx.execute("ALTER TABLE connector_resource RENAME TO connector_resource_node_legacy")
            tx.execute(
                "CREATE TABLE connector_resource ("
                "id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, payload TEXT NOT NULL, "
                "status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
            )
            tx.executemany(
                "INSERT INTO connector_resource(id,connector_id,payload,status,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?)",
                converted,
            )
            tx.execute("DROP TABLE connector_resource_node_legacy")

    @staticmethod
    def _single_profile_connector_id(connection: sqlite3.Connection) -> str | None:
        table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='portal_state'"
        ).fetchone()
        if not table:
            return None
        row = connection.execute("SELECT payload FROM portal_state WHERE id=1").fetchone()
        if not row:
            return None
        try:
            state = json.loads(row["payload"])
            profiles = state.get("connectors") or {}
            connector_ids = {
                str(profile.get("connector_id") or key)
                for key, profile in profiles.items()
                if isinstance(profile, dict) and (profile.get("connector_id") or key)
            }
            return next(iter(connector_ids)) if len(connector_ids) == 1 else None
        except (TypeError, ValueError, AttributeError):
            return None

    def _import_legacy_appimages(self, connection: sqlite3.Connection) -> None:
        if connection.execute("SELECT COUNT(*) FROM application_image").fetchone()[0]:
            return
        legacy = self.path.parent / "appimages.json"
        if not legacy.is_file():
            return
        try:
            values = json.loads(legacy.read_text())
        except (OSError, ValueError):
            return
        if not isinstance(values, dict):
            return
        rows = []
        for key, raw in values.items():
            if not isinstance(raw, dict):
                continue
            value = dict(raw); value["name"] = str(value.get("name") or key)
            if not value["name"] or not value.get("image_name") or not value.get("image_tag"):
                continue
            registered_at = str(value.get("registered_at") or datetime.datetime.now(datetime.timezone.utc).isoformat())
            value["registered_at"] = registered_at
            rows.append((value["name"], json.dumps(value, ensure_ascii=True), registered_at))
        if rows:
            with self.transaction(immediate=True) as tx:
                tx.executemany("INSERT OR IGNORE INTO application_image(name,payload,registered_at) VALUES(?,?,?)", rows)

    def datasource(self, datasource_id: str, connector_id: str) -> dict[str, Any] | None:
        row = self.connection().execute(
            "SELECT payload FROM datasource WHERE id=? AND connector_id=?", (datasource_id, connector_id)
        ).fetchone()
        return json.loads(row["payload"]) if row else None

    def datasources(self, connector_id: str) -> list[dict[str, Any]]:
        rows = self.connection().execute(
            "SELECT payload FROM datasource WHERE connector_id=? ORDER BY created_at DESC", (connector_id,)
        ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def reassign_connector(self, old_connector_id: str, new_connector_id: str) -> None:
        """Move local ownership after the center has removed and reissued a connector.

        Catalog rows remain attached to datasource ids. Application images are local
        engine definitions and are deliberately not connector-scoped.
        """
        if not old_connector_id or not new_connector_id or old_connector_id == new_connector_id:
            return
        with self.transaction(immediate=True) as tx:
            for table in ("datasource", "connector_resource"):
                rows = tx.execute(
                    f"SELECT id,payload FROM {table} WHERE connector_id=?", (old_connector_id,)
                ).fetchall()
                for row in rows:
                    payload = json.loads(row["payload"])
                    payload["connector_id"] = new_connector_id
                    tx.execute(
                        f"UPDATE {table} SET connector_id=?,payload=? WHERE id=?",
                        (new_connector_id, json.dumps(payload, ensure_ascii=True), row["id"]),
                    )
            rows = tx.execute("SELECT scope,key,payload FROM durable_record").fetchall()
            for row in rows:
                payload = json.loads(row["payload"])
                if payload.get("connector_id") != old_connector_id:
                    continue
                payload["connector_id"] = new_connector_id
                tx.execute(
                    "UPDATE durable_record SET payload=? WHERE scope=? AND key=?",
                    (json.dumps(payload, ensure_ascii=True), row["scope"], row["key"]),
                )

    def resource(self, resource_id: str, connector_id: str) -> dict[str, Any] | None:
        row = self.connection().execute(
            "SELECT payload FROM connector_resource WHERE id=? AND connector_id=?",
            (resource_id, connector_id),
        ).fetchone()
        return json.loads(row["payload"]) if row else None

    def resources(self, connector_id: str) -> list[dict[str, Any]]:
        rows = self.connection().execute(
            "SELECT payload FROM connector_resource WHERE connector_id=? ORDER BY updated_at DESC",
            (connector_id,),
        ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def save_resource(self, resource: dict[str, Any]) -> dict[str, Any]:
        now = resource["updated_at"]
        self.connection().execute(
            "INSERT INTO connector_resource(id,connector_id,payload,status,created_at,updated_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,status=excluded.status,updated_at=excluded.updated_at",
            (resource["id"], resource["connector_id"], json.dumps(resource, ensure_ascii=True),
             resource["status"], resource["created_at"], now),
        )
        return resource

    def delete_resource(self, resource_id: str, connector_id: str) -> bool:
        result = self.connection().execute(
            "DELETE FROM connector_resource WHERE id=? AND connector_id=?", (resource_id, connector_id)
        )
        return result.rowcount > 0

    def durable_read(self, scope: str, key: str) -> dict[str, Any] | None:
        row = self.connection().execute("SELECT payload FROM durable_record WHERE scope=? AND key=?", (scope, key)).fetchone()
        return json.loads(row["payload"]) if row else None

    def durable_write(self, scope: str, key: str, payload: dict[str, Any], state: str | None = None) -> None:
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        self.connection().execute(
            "INSERT INTO durable_record(scope,key,payload,state,created_at,updated_at) VALUES(?,?,?,?,?,?) "
            "ON CONFLICT(scope,key) DO UPDATE SET payload=excluded.payload,state=excluded.state,updated_at=excluded.updated_at",
            (scope, key, json.dumps(payload, ensure_ascii=True), state, now, now),
        )

    def durable_list(self, scope: str) -> list[dict[str, Any]]:
        rows = self.connection().execute("SELECT payload FROM durable_record WHERE scope=? ORDER BY updated_at DESC", (scope,)).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def durable_delete(self, scope: str, key: str) -> bool:
        result = self.connection().execute(
            "DELETE FROM durable_record WHERE scope=? AND key=?", (scope, key)
        )
        return result.rowcount > 0

    def application_image(self, name: str) -> dict[str, Any] | None:
        row = self.connection().execute("SELECT payload FROM application_image WHERE name=?", (name,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def application_images(self) -> list[dict[str, Any]]:
        rows = self.connection().execute(
            "SELECT payload FROM application_image ORDER BY registered_at DESC"
        ).fetchall()
        return [json.loads(row["payload"]) for row in rows]

    def save_application_image(self, value: dict[str, Any]) -> dict[str, Any]:
        self.connection().execute("INSERT INTO application_image(name,payload,registered_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload,registered_at=excluded.registered_at",
                                  (value["name"], json.dumps(value, ensure_ascii=True), value["registered_at"]))
        return value


def _statements(script: str) -> list[str]:
    statements: list[str] = []
    current = ""
    for line in script.splitlines():
        current += line + "\n"
        if sqlite3.complete_statement(current):
            statements.append(current.strip())
            current = ""
    if current.strip():
        statements.append(current.strip())
    return statements
