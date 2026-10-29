from __future__ import annotations

import re

from .errors import DomainError


STANDARD_TYPES = {
    "string", "boolean", "tinyint", "smallint", "int", "bigint",
    "float", "double", "date", "time", "timestamp", "bytes",
}
DECIMAL = re.compile(r"^decimal\(([1-9]\d*),\s*(\d+)\)$", re.IGNORECASE)


def standard_type(value: str) -> str:
    raw = str(value or "").strip().lower()
    aliases = {
        "str": "string", "varchar": "string", "text": "string", "bool": "boolean",
        "integer": "int", "int4": "int", "int8": "bigint", "long": "bigint",
        "real": "float", "binary": "bytes", "varbinary": "bytes", "datetime": "timestamp",
    }
    result = aliases.get(raw, raw)
    if result in STANDARD_TYPES:
        return result
    decimal = DECIMAL.fullmatch(result)
    if decimal and int(decimal.group(2)) <= int(decimal.group(1)) <= 38:
        return f"decimal({int(decimal.group(1))},{int(decimal.group(2))})"
    raise DomainError(422, f"不支持的标准字段类型: {value}")

