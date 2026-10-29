from __future__ import annotations

import json
import posixpath
import threading
import uuid
from datetime import datetime, timezone
from typing import Any

from ..config import Settings
from ..domain.catalog import DataObject, InspectionResult, ObjectPage
from ..domain.errors import DomainError
from ..infrastructure.database import Database
from ..infrastructure.object_refs import decode_ref
from ..infrastructure.providers import provider_for


class CatalogService:
    def __init__(self, database: Database, settings: Settings):
        self.database = database
        self.settings = settings
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def source(self, datasource_id: str, connector_id: str) -> dict[str, Any]:
        source = self.database.datasource(datasource_id, connector_id)
        if not source:
            raise DomainError(404, "数据源不存在或不属于当前连接器")
        return source

    def provider(self, datasource_id: str, connector_id: str):
        return provider_for(self.source(datasource_id, connector_id), self.settings)

    def capability(self, datasource_id: str, connector_id: str) -> dict[str, Any]:
        provider = self.provider(datasource_id, connector_id)
        try:
            result = provider.capability()
            return {"datasource_id": datasource_id, **result,
                    "limits": {"max_sample_rows": self.settings.catalog_max_sample_rows,
                               "max_sample_bytes": self.settings.catalog_max_sample_bytes,
                               "timeout_ms": int(self.settings.catalog_timeout_seconds * 1000)}}
        except Exception as exc:
            return {"datasource_id": datasource_id, "provider": getattr(provider, "name", "unknown"),
                    "available": False, "operations": {"browse": True, "search": True,
                    "inspect_schema": True, "preview_rows": True}, "warnings": [str(exc)]}
        finally:
            close = getattr(provider, "close", None)
            if close: close()

    def objects(self, datasource_id: str, connector_id: str, parent_ref: str | None,
                cursor: str | None, limit: int, query: str | None = None,
                kinds: set[str] | None = None) -> ObjectPage:
        limit = min(max(limit, 1), self.settings.catalog_max_page_size)
        if query:
            self.source(datasource_id, connector_id)
            offset = _offset(cursor)
            kind_sql = ""
            parameters: list[Any] = [datasource_id, _fts_query(query)]
            if kinds:
                kind_sql = " AND c.kind IN (" + ",".join("?" for _ in kinds) + ")"
                parameters.extend(sorted(kinds))
            parameters.extend([limit + 1, offset])
            rows = self.database.connection().execute(
                "SELECT c.object_ref,c.kind,c.name,c.path,c.parent_ref,c.data_kind,c.format,c.selectable,c.expandable, "
                "c.inspectable,c.transferable,c.size,c.modified_at,c.metadata,c.indexed_at FROM catalog_object c "
                "JOIN catalog_object_fts ON catalog_object_fts.datasource_id=c.datasource_id "
                "AND catalog_object_fts.object_ref=c.object_ref "
                "WHERE c.datasource_id=? AND catalog_object_fts MATCH ?" + kind_sql +
                " ORDER BY c.name,c.object_ref LIMIT ? OFFSET ?",
                parameters,
            ).fetchall()
            has_more = len(rows) > limit
            page_rows = rows[:limit]
            items = [_row_object(row) for row in page_rows]
            return ObjectPage(items, str(offset + limit) if has_more else None, has_more,
                              page_rows[0]["indexed_at"] if page_rows else None)
        provider = self.provider(datasource_id, connector_id)
        try:
            page = provider.list_objects(parent_ref, cursor, limit)
            return page
        finally:
            close = getattr(provider, "close", None)
            if close: close()

    def directory_ref(self, datasource_id: str, connector_id: str, path: str) -> str | None:
        """Resolve a compatibility API path to the provider's opaque directory reference."""
        normalized = path.strip("/")
        if not normalized:
            return None
        if "\\" in normalized or ".." in normalized.split("/") or "" in normalized.split("/"):
            raise DomainError(422, "目录路径越界")
        parent_ref: str | None = None
        current = ""
        for segment in normalized.split("/"):
            current = posixpath.join(current, segment)
            cursor: str | None = None
            matched: DataObject | None = None
            while True:
                page = self.objects(datasource_id, connector_id, parent_ref, cursor,
                                    self.settings.catalog_max_page_size)
                matched = next((item for item in page.items
                                if item.kind == "directory" and item.path.strip("/") == current), None)
                if matched or not page.next_cursor:
                    break
                cursor = page.next_cursor
            if not matched:
                raise DomainError(404, f"目录不存在: {path}")
            parent_ref = matched.object_ref
        return parent_ref

    def object_ref_for_path(self, datasource_id: str, connector_id: str, path: str) -> str:
        """Resolve a browsed relative path without requiring the optional search index."""
        normalized = path.strip("/")
        if not normalized or "\\" in normalized or ".." in normalized.split("/"):
            raise DomainError(422, "数据对象路径越界")
        parent_path, _, _name = normalized.rpartition("/")
        parent_ref = self.directory_ref(datasource_id, connector_id, parent_path)
        cursor: str | None = None
        while True:
            page = self.objects(datasource_id, connector_id, parent_ref, cursor,
                                self.settings.catalog_max_page_size)
            match = next((item for item in page.items if item.path.strip("/") == normalized), None)
            if match:
                return match.object_ref
            if not page.next_cursor:
                break
            cursor = page.next_cursor

        raise DomainError(404, "找不到需要扫描的数据对象")

    def inspect(self, datasource_id: str, connector_id: str, object_ref: str,
                sample_rows: int, options: dict[str, Any]) -> InspectionResult:
        provider = self.provider(datasource_id, connector_id)
        try:
            result = provider.inspect(object_ref, min(max(sample_rows, 1), self.settings.catalog_max_sample_rows), options)
            self.database.connection().execute(
                "INSERT INTO schema_cache(datasource_id, object_ref, fingerprint, payload, inspected_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(datasource_id, object_ref) DO UPDATE SET fingerprint=excluded.fingerprint,payload=excluded.payload,inspected_at=excluded.inspected_at",
                (datasource_id, object_ref, result.fingerprint, json.dumps(_inspection_dict(result), default=str), _now()),
            )
            return result
        finally:
            close = getattr(provider, "close", None)
            if close: close()

    def start_index(self, datasource_id: str, connector_id: str) -> dict[str, Any]:
        self.source(datasource_id, connector_id)
        lock = self._lock(datasource_id)
        if not lock.acquire(blocking=False):
            return self.index_status(datasource_id, connector_id) or {"state": "running", "datasource_id": datasource_id}
        run_id = str(uuid.uuid4()); generation = int(datetime.now().timestamp())
        now = _now()
        self.database.connection().execute(
            "INSERT INTO catalog_index_run(id,datasource_id,state,generation,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (run_id, datasource_id, "running", generation, now, now),
        )
        def worker():
            try:
                provider = self.provider(datasource_id, connector_id)
                count = 0
                try:
                    for item in provider.walk():
                        self._save_object(datasource_id, item, generation)
                        count += 1
                finally:
                    close = getattr(provider, "close", None)
                    if close: close()
                self.database.connection().execute(
                    "UPDATE catalog_index_run SET state='succeeded',object_count=?,updated_at=?,completed_at=? WHERE id=?",
                    (count, _now(), _now(), run_id),
                )
                stale = self.database.connection().execute(
                    "SELECT object_ref FROM catalog_object WHERE datasource_id=? AND generation<>?", (datasource_id, generation)
                ).fetchall()
                for row in stale:
                    self.database.connection().execute(
                        "DELETE FROM catalog_object_fts WHERE datasource_id=? AND object_ref=?", (datasource_id, row["object_ref"])
                    )
                self.database.connection().execute(
                    "DELETE FROM catalog_object WHERE datasource_id=? AND generation<>?", (datasource_id, generation)
                )
            except Exception as exc:
                self.database.connection().execute(
                    "UPDATE catalog_index_run SET state='failed',error=?,updated_at=? WHERE id=?",
                    (str(exc)[:500], _now(), run_id),
                )
            finally:
                lock.release()
        threading.Thread(target=worker, name=f"catalog-index-{datasource_id}", daemon=True).start()
        return {"id": run_id, "datasource_id": datasource_id, "state": "running", "generation": generation}

    def index_status(self, datasource_id: str, connector_id: str) -> dict[str, Any] | None:
        self.source(datasource_id, connector_id)
        row = self.database.connection().execute(
            "SELECT id,datasource_id,state,generation,cursor,object_count,error,created_at,updated_at,completed_at "
            "FROM catalog_index_run WHERE datasource_id=? ORDER BY created_at DESC LIMIT 1", (datasource_id,)
        ).fetchone()
        return dict(row) if row else None

    def _save_object(self, datasource_id: str, item: DataObject, generation: int) -> None:
        now = _now(); metadata = json.dumps(item.metadata, ensure_ascii=True)
        self.database.connection().execute(
            "INSERT INTO catalog_object(datasource_id,object_ref,parent_ref,kind,name,path,data_kind,format,selectable,expandable,inspectable,transferable,size,modified_at,metadata,generation,indexed_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(datasource_id,object_ref) DO UPDATE SET parent_ref=excluded.parent_ref,kind=excluded.kind,name=excluded.name,path=excluded.path,data_kind=excluded.data_kind,format=excluded.format,selectable=excluded.selectable,expandable=excluded.expandable,inspectable=excluded.inspectable,transferable=excluded.transferable,size=excluded.size,modified_at=excluded.modified_at,metadata=excluded.metadata,generation=excluded.generation,indexed_at=excluded.indexed_at",
            (datasource_id, item.object_ref, item.parent_ref, item.kind, item.name, item.path, item.data_kind, item.format,
             int(item.selectable), int(item.expandable), int(item.inspectable), int(item.transferable), item.size, item.modified_at, metadata, generation, now),
        )
        self.database.connection().execute("DELETE FROM catalog_object_fts WHERE datasource_id=? AND object_ref=?", (datasource_id, item.object_ref))
        self.database.connection().execute("INSERT INTO catalog_object_fts(datasource_id,object_ref,name,path) VALUES(?,?,?,?)",
                                           (datasource_id, item.object_ref, item.name, item.path))

    def _lock(self, datasource_id: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(datasource_id, threading.Lock())


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fts_query(value: str) -> str:
    tokens = [token.replace('"', '""') for token in value.strip().split() if token]
    if not tokens: raise DomainError(422, "搜索关键词不能为空")
    return " AND ".join(f'"{token}"*' for token in tokens)


def _offset(cursor: str | None) -> int:
    try:
        value = int(cursor or 0)
    except ValueError as exc:
        raise DomainError(422, "无效的分页游标") from exc
    if value < 0:
        raise DomainError(422, "无效的分页游标")
    return value


def _inspection_dict(value: InspectionResult) -> dict[str, Any]:
    return {"object_ref": value.object_ref, "data_kind": value.data_kind, "format": value.format,
            "schema_source": value.schema_source, "columns": [column.__dict__ for column in value.columns],
            "sampled_rows": value.sampled_rows, "complete": value.complete, "fingerprint": value.fingerprint,
            "warnings": value.warnings}


def _row_object(row: Any) -> DataObject:
    return DataObject(row["object_ref"], row["kind"], row["name"], row["path"], row["parent_ref"], bool(row["selectable"]), bool(row["expandable"]),
                      row["data_kind"], row["format"], row["size"], row["modified_at"], bool(row["inspectable"]), bool(row["transferable"]), json.loads(row["metadata"] or "{}"))
