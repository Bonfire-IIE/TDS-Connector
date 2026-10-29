from __future__ import annotations

"""Data-catalog HTTP adapter.

The catalog domain is deliberately unaware of FastAPI and authorization.  This
adapter translates request arguments into the application service calls and
keeps compatibility responses for the existing React client in one place.
"""

import asyncio
from datetime import datetime, timezone
from typing import Any

from ...application.catalog import CatalogService, _inspection_dict
from ...config import Settings
from ...domain.errors import DomainError


class CatalogHttpAdapter:
    def __init__(self, catalog: CatalogService, settings: Settings):
        self.catalog, self.settings = catalog, settings

    async def capability(self, datasource_id: str, connector_id: str) -> dict[str, Any]:
        result = await asyncio.to_thread(self.catalog.capability, datasource_id, connector_id)
        operations = result.get("operations") or {}
        return {
            **result,
            # Compatibility projection for the current React file picker.
            "type": result.get("provider"),
            "listing": bool(result.get("available") and operations.get("browse")),
            "scanning": bool(result.get("available") and operations.get("inspect_schema")),
            "reason": None if result.get("available") else "; ".join(result.get("warnings") or ["数据源不可用"]),
        }

    async def probe(self, datasource_id: str, connector_id: str) -> dict[str, Any]:
        capability = await self.capability(datasource_id, connector_id)
        available = bool(capability.get("available"))
        warnings = capability.get("warnings", [])
        return {
            "datasource_id": datasource_id,
            "status": "available" if available else "unavailable",
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "message": "连接成功" if available else str(warnings[0] if warnings else "数据源不可用"),
            "available": available,
            "provider": capability.get("provider"),
            "operations": capability.get("operations", {}),
            "warnings": warnings,
        }

    async def details(self, datasource_id: str, connector_id: str, publicize) -> dict[str, Any]:
        return publicize(self.catalog.source(datasource_id, connector_id))

    async def objects(self, datasource_id: str, connector_id: str, parent_ref: str | None,
                      cursor: str | None, limit: int, query: str | None, kinds: set[str] | None) -> dict[str, Any]:
        page = await asyncio.to_thread(self.catalog.objects, datasource_id, connector_id, parent_ref,
                                       cursor, limit, query, kinds)
        return {"items": [item.__dict__ for item in page.items], "next_cursor": page.next_cursor,
                "truncated": page.truncated, "indexed_at": page.indexed_at}

    async def inspect(self, datasource_id: str, connector_id: str, object_ref: str,
                      sample_rows: int, options: dict[str, Any]) -> dict[str, Any]:
        if not object_ref:
            raise DomainError(422, "需要 object_ref")
        result = await asyncio.to_thread(self.catalog.inspect, datasource_id, connector_id, object_ref,
                                         sample_rows, options)
        return _inspection_dict(result) | {"sample": result.sample}

    async def index_status(self, datasource_id: str, connector_id: str) -> dict[str, Any] | None:
        return await asyncio.to_thread(self.catalog.index_status, datasource_id, connector_id)

    async def start_index(self, datasource_id: str, connector_id: str) -> dict[str, Any]:
        return await asyncio.to_thread(self.catalog.start_index, datasource_id, connector_id)

    async def files(self, datasource_id: str, connector_id: str, path: str) -> dict[str, Any]:
        if self.catalog.source(datasource_id, connector_id).get("type") == "jdbc":
            raise DomainError(422, "数据库数据源请使用 Schema 与表浏览接口")
        parent = await asyncio.to_thread(self.catalog.directory_ref, datasource_id, connector_id, path)
        page = await asyncio.to_thread(self.catalog.objects, datasource_id, connector_id, parent, None,
                                       self.settings.catalog_page_size, None, None)
        return {"directory": path, "entries": [
            {"path": item.path, "kind": "directory" if item.kind == "directory" else "file",
             "size": item.size, "modified_at": item.modified_at, "format": item.format,
             "data_kind": item.data_kind, "transferable": item.transferable,
             "inspectable": item.inspectable, "object_ref": item.object_ref}
            for item in page.items
        ], "truncated": page.truncated}

    async def scan(self, datasource_id: str, connector_id: str, value: str, sample_rows: int) -> dict[str, Any]:
        if self.catalog.source(datasource_id, connector_id).get("type") == "jdbc":
            raise DomainError(422, "数据库数据源请使用表结构探测接口")
        if not value:
            raise DomainError(422, "需要 file 或 object_ref")
        if not value.startswith("obj1."):
            value = await asyncio.to_thread(
                self.catalog.object_ref_for_path, datasource_id, connector_id, value
            )
        inspected = await self.inspect(datasource_id, connector_id, value, sample_rows, {})
        return self._project_scan(inspected)

    async def database_schemas(self, datasource_id: str, connector_id: str,
                               cursor: str | None = None) -> dict[str, Any]:
        self._require_database(datasource_id, connector_id)
        page = await asyncio.to_thread(
            self.catalog.objects, datasource_id, connector_id, None, cursor,
            self.settings.catalog_max_page_size, None, {"schema"},
        )
        return {"items": [
            {"name": item.name, "object_ref": item.object_ref}
            for item in page.items if item.kind == "schema" and item.expandable
        ], "next_cursor": page.next_cursor, "truncated": page.truncated}

    async def database_relations(self, datasource_id: str, connector_id: str,
                                 schema_ref: str, cursor: str | None = None) -> dict[str, Any]:
        self._require_database(datasource_id, connector_id)
        if not schema_ref:
            raise DomainError(422, "需要 schema_ref")
        page = await asyncio.to_thread(
            self.catalog.objects, datasource_id, connector_id, schema_ref, cursor,
            self.settings.catalog_max_page_size, None, {"table", "view"},
        )
        return {"items": [
            {"name": item.name, "schema": item.path.rpartition(".")[0],
             "qualified_name": item.path, "relation_type": item.kind,
             "object_ref": item.object_ref, "inspectable": item.inspectable,
             "transferable": item.transferable}
            for item in page.items if item.kind in {"table", "view"}
        ], "next_cursor": page.next_cursor, "truncated": page.truncated}

    async def database_inspect(self, datasource_id: str, connector_id: str,
                               object_ref: str, sample_rows: int) -> dict[str, Any]:
        self._require_database(datasource_id, connector_id)
        if not object_ref:
            raise DomainError(422, "需要 object_ref")
        inspected = await self.inspect(datasource_id, connector_id, object_ref, sample_rows, {})
        return self._project_scan(inspected)

    def _require_database(self, datasource_id: str, connector_id: str) -> None:
        if self.catalog.source(datasource_id, connector_id).get("type") != "jdbc":
            raise DomainError(422, "该接口仅适用于数据库数据源")

    @staticmethod
    def _project_scan(inspected: dict[str, Any]) -> dict[str, Any]:
        rows = inspected.get("sample") or []
        projected = []
        for index, column in enumerate(inspected.get("columns") or []):
            standard = str(column.get("type") or "string")
            values = [row[index] for row in rows if isinstance(row, list) and index < len(row) and row[index] is not None]
            if standard in {"tinyint", "smallint", "int", "bigint"}:
                kind = "integer"
            elif standard in {"float", "double"} or standard.startswith("decimal("):
                kind = "double"
            elif standard == "boolean":
                kind = "boolean"
            else:
                distinct = list(dict.fromkeys(str(item) for item in values))
                kind = "enum" if distinct and len(distinct) <= 20 else "string"
            item = {**column, "kind": kind}
            if kind in {"integer", "double"} and values:
                numbers = [float(item) for item in values if isinstance(item, (int, float))]
                if numbers:
                    item.update({"min": min(numbers), "max": max(numbers)})
            if kind in {"enum", "boolean"}:
                item["values"] = list(dict.fromkeys(str(value) for value in values))[:20]
            projected.append(item)
        return {**inspected, "columns": projected}
