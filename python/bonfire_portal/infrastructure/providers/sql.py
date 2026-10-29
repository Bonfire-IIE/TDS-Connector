from __future__ import annotations

import hashlib
import json
import re
from typing import Any
from urllib.parse import quote_plus

from sqlalchemy import MetaData, Table, create_engine, inspect, select
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool

from ...domain.catalog import ColumnSchema, DataObject, InspectionResult, ObjectPage
from ...domain.errors import DomainError
from ..object_refs import decode_ref, encode_ref


class SqlProvider:
    name = "jdbc"

    def __init__(self, source: dict[str, Any]):
        self.source = source
        self.engine = _engine(source)

    def capability(self) -> dict[str, Any]:
        dialect = self.engine.dialect.name
        if dialect not in {"mysql", "postgresql"}:
            raise DomainError(422, "数据目录首期只支持 MySQL 和 PostgreSQL")
        with self.engine.connect() as connection:
            connection.exec_driver_sql("SELECT 1")
        return {"provider": "jdbc", "available": True,
                "operations": {"browse": True, "search": True, "inspect_schema": True, "preview_rows": True},
                "object_kinds": ["schema", "table", "view"], "structured_formats": ["table"],
                "pagination": {"supported": True}}

    def list_objects(self, parent_ref: str | None, cursor: str | None, limit: int) -> ObjectPage:
        inspector = inspect(self.engine)
        locator = decode_ref(parent_ref, self.name) if parent_ref else {"kind": "root"}
        if locator.get("kind") == "root":
            excluded = {"information_schema", "pg_catalog", "pg_toast", "mysql", "performance_schema", "sys"}
            names = sorted(name for name in inspector.get_schema_names() if name not in excluded)
            items = [DataObject(encode_ref(self.name, {"kind": "schema", "schema": name}), "schema", name,
                                name, parent_ref, False, True) for name in names]
        elif locator.get("kind") == "schema":
            schema = _identifier(locator.get("schema"))
            tables = [(name, "table") for name in inspector.get_table_names(schema=schema)]
            views = [(name, "view") for name in inspector.get_view_names(schema=schema)]
            items = [DataObject(encode_ref(self.name, {"kind": kind, "schema": schema, "name": name}), kind,
                                name, f"{schema}.{name}", parent_ref, True, False, "structured", "table",
                                inspectable=True, transferable=True) for name, kind in sorted(tables + views)]
        else:
            raise DomainError(422, "该数据库对象不能展开")
        start = _offset(cursor)
        page = items[start:start + limit]
        next_cursor = str(start + limit) if start + limit < len(items) else None
        return ObjectPage(page, next_cursor, next_cursor is not None)

    def inspect(self, object_ref: str, sample_rows: int, options: dict[str, Any]) -> InspectionResult:
        locator = decode_ref(object_ref, self.name)
        kind = locator.get("kind")
        if kind not in {"table", "view"}:
            raise DomainError(422, "只有表和视图可以探测结构")
        schema = _identifier(locator.get("schema"))
        name = _identifier(locator.get("name"))
        inspector = inspect(self.engine)
        raw_columns = inspector.get_columns(name, schema=schema)
        if not raw_columns:
            raise DomainError(404, "数据库表或视图不存在")
        columns = [ColumnSchema(str(column["name"]), _sql_type(column["type"]), str(column["type"]),
                                bool(column.get("nullable", True)), 1.0) for column in raw_columns]
        metadata = MetaData()
        table = Table(name, metadata, schema=schema, autoload_with=self.engine)
        try:
            with self.engine.connect() as connection:
                rows = [[_value(value) for value in row] for row in connection.execute(select(table).limit(sample_rows)).fetchall()]
        except Exception as exc:
            raise DomainError(422, f"表结构可读，但样本读取失败: {str(exc).splitlines()[0]}") from exc
        signature = json.dumps({"schema": schema, "name": name, "columns": [column.__dict__ for column in columns]},
                               sort_keys=True).encode()
        return InspectionResult(object_ref, "structured", "table", "declared", columns, len(rows),
                                len(rows) < sample_rows, rows, "sha256:" + hashlib.sha256(signature).hexdigest())

    def walk(self):
        schemas = self.list_objects(None, None, 10_000).items
        for schema in schemas:
            yield schema
            cursor = None
            while True:
                page = self.list_objects(schema.object_ref, cursor, 500)
                yield from page.items
                if not page.next_cursor:
                    break
                cursor = page.next_cursor

    def close(self) -> None:
        self.engine.dispose()


def _engine(source: dict[str, Any]) -> Engine:
    options = source.get("info", {}).get("options", {})
    raw = str(options.get("url") or "")
    user = quote_plus(str(options.get("user") or options.get("username") or ""))
    password = quote_plus(str(options.get("password") or ""))
    match = re.fullmatch(r"jdbc:(mysql|postgresql)://([^/:?#]+)(?::(\d+))?/([^?]+)(?:\?.*)?", raw)
    if match:
        kind, host, port, database = match.groups()
        driver = "mysql+pymysql" if kind == "mysql" else "postgresql+psycopg"
        default_port = "3306" if kind == "mysql" else "5432"
        url = f"{driver}://{user}:{password}@{host}:{port or default_port}/{database}"
    else:
        kind = str(options.get("engine") or "")
        if kind not in {"mysql", "postgresql"}:
            raise DomainError(422, "数据库连接需要 MySQL/PostgreSQL JDBC URL 或 engine 配置")
        driver = "mysql+pymysql" if kind == "mysql" else "postgresql+psycopg"
        host = str(options.get("host") or "")
        port = int(options.get("port") or (3306 if kind == "mysql" else 5432))
        database = str(options.get("database") or "")
        if not host or not database or not user:
            raise DomainError(422, "数据库连接缺少 host、database 或 user")
        url = f"{driver}://{user}:{password}@{host}:{port}/{database}"
    connect_args: dict[str, Any] = {"connect_timeout": 15}
    return create_engine(url, poolclass=NullPool, connect_args=connect_args)


def _identifier(value: Any) -> str:
    text = str(value or "")
    if not text or "\x00" in text or len(text) > 256:
        raise DomainError(422, "无效的数据库对象标识")
    return text


def _sql_type(value: Any) -> str:
    text = str(value).lower()
    if "bool" in text: return "boolean"
    if "tinyint" in text: return "tinyint"
    if "smallint" in text: return "smallint"
    if "bigint" in text: return "bigint"
    if re.search(r"(^|\W)(int|integer)(\W|$)", text): return "int"
    if any(item in text for item in ("double", "float8")): return "double"
    if any(item in text for item in ("float", "real")): return "float"
    decimal = re.search(r"(?:decimal|numeric)\((\d+),\s*(\d+)\)", text)
    if decimal and int(decimal.group(1)) <= 38: return f"decimal({decimal.group(1)},{decimal.group(2)})"
    if "timestamp" in text or "datetime" in text: return "timestamp"
    if text.startswith("date"): return "date"
    if text.startswith("time"): return "time"
    if any(item in text for item in ("binary", "blob", "bytea")): return "bytes"
    return "string"


def _offset(cursor: str | None) -> int:
    try: value = int(cursor or 0)
    except ValueError as exc: raise DomainError(422, "无效的分页游标") from exc
    return max(value, 0)


def _value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)): return value
    if isinstance(value, bytes): return f"<bytes:{len(value)}>"
    if hasattr(value, "isoformat"): return value.isoformat()
    return str(value)

