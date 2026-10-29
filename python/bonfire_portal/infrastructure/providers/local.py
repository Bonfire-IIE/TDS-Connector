from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ...domain.catalog import DataObject, InspectionResult, ObjectPage
from ...domain.errors import DomainError
from ..inspection import inspect_path, workbook_sheets
from ..object_refs import decode_ref, encode_ref


STRUCTURED = {".csv": "csv", ".tsv": "tsv", ".json": "json", ".jsonl": "jsonl", ".ndjson": "jsonl",
              ".parquet": "parquet", ".orc": "orc", ".xlsx": "xlsx", ".xlsm": "xlsx"}
TRANSFERABLE_FORMATS = {"csv", "tsv", "json", "jsonl", "parquet", "orc"}

# A legacy datasource may point at /data, which also contains Portal state.
# These names are implementation details and must never become catalog objects.
RESERVED_ROOT_NAMES = {
    "identity", "lite", "extractions", "logs", "portal.sqlite", "portal.sqlite-wal",
    "portal.sqlite-shm", "portal-state.json", "portal-state.pre-csr-v2.json",
    "appimages.json", "data-sources.json", "audit-mirror.json",
}


class LocalProvider:
    name = "localfs"

    def __init__(self, source: dict[str, Any], mounted_root: Path | None = None):
        configured = Path(str(source.get("info", {}).get("path") or source.get("uri") or ""))
        if mounted_root is not None and (configured == Path("/data") or str(configured).startswith("/data/")):
            configured = mounted_root / configured.relative_to("/data")
        self.root = configured.resolve()
        if not self.root.is_absolute() or not self.root.exists() or not self.root.is_dir():
            raise DomainError(409, "本地数据源根目录不存在或不可访问")

    def capability(self) -> dict[str, Any]:
        return _capability("localfs", ["directory", "file", "workbook", "sheet"])

    def list_objects(self, parent_ref: str | None, cursor: str | None, limit: int) -> ObjectPage:
        locator = decode_ref(parent_ref, self.name) if parent_ref else {"kind": "directory", "path": ""}
        if locator.get("kind") == "workbook":
            path = self._path(str(locator.get("path", "")))
            names = workbook_sheets(path)
            start = _offset(cursor)
            items = [DataObject(encode_ref(self.name, {"kind": "sheet", "path": locator["path"], "sheet": name}),
                                "sheet", name, f"{locator['path']}#{name}", parent_ref, True, False,
                                "structured", "xlsx", inspectable=True, transferable=False)
                     for name in names[start:start + limit]]
            next_cursor = str(start + limit) if start + limit < len(names) else None
            return ObjectPage(items, next_cursor, next_cursor is not None)
        if locator.get("kind") != "directory":
            raise DomainError(422, "该对象不能展开")
        directory = self._path(str(locator.get("path", "")))
        if not directory.is_dir():
            raise DomainError(404, "目录不存在")
        entries = sorted(directory.iterdir(), key=lambda item: (not item.is_dir(), item.name.casefold()))
        entries = [entry for entry in entries
                   if not entry.is_symlink() and self._visible(entry, str(locator.get("path", "")))]
        start = _offset(cursor)
        items = [self._object(entry, parent_ref) for entry in entries[start:start + limit]]
        next_cursor = str(start + limit) if start + limit < len(entries) else None
        return ObjectPage(items, next_cursor, next_cursor is not None)

    def inspect(self, object_ref: str, sample_rows: int, options: dict[str, Any]) -> InspectionResult:
        locator = decode_ref(object_ref, self.name)
        if locator.get("kind") not in {"file", "workbook", "sheet"}:
            raise DomainError(422, "该对象不是可探测的结构化数据")
        path = self._path(str(locator.get("path", "")))
        merged = {**options, **({"sheet": locator["sheet"]} if locator.get("kind") == "sheet" else {})}
        return inspect_path(path, object_ref, sample_rows, merged)

    def walk(self):
        stack: list[tuple[Path, str | None]] = [(self.root, None)]
        while stack:
            directory, parent_ref = stack.pop()
            for entry in sorted(directory.iterdir(), key=lambda item: item.name.casefold()):
                if entry.is_symlink() or not self._visible(entry, entry.relative_to(self.root).parent.as_posix()):
                    continue
                item = self._object(entry, parent_ref)
                yield item
                if entry.is_dir():
                    stack.append((entry, item.object_ref))

    def _object(self, path: Path, parent_ref: str | None) -> DataObject:
        relative = path.relative_to(self.root).as_posix()
        stat = path.stat()
        modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat()
        if path.is_dir():
            return DataObject(encode_ref(self.name, {"kind": "directory", "path": relative}), "directory",
                              path.name, relative, parent_ref, False, True, modified_at=modified)
        fmt = STRUCTURED.get(path.suffix.lower())
        if fmt == "xlsx":
            return DataObject(encode_ref(self.name, {"kind": "workbook", "path": relative}), "workbook",
                              path.name, relative, parent_ref, False, True, "structured", fmt, stat.st_size,
                              modified, True, False)
        return DataObject(encode_ref(self.name, {"kind": "file", "path": relative}), "file", path.name,
                          relative, parent_ref, True, False, "structured" if fmt else "unstructured",
                          fmt or "binary", stat.st_size, modified, bool(fmt), fmt in TRANSFERABLE_FORMATS)

    def _path(self, relative: str) -> Path:
        if "\\" in relative or Path(relative).is_absolute() or ".." in Path(relative).parts:
            raise DomainError(422, "对象路径越界")
        path = (self.root / relative).resolve()
        if path != self.root and self.root not in path.parents:
            raise DomainError(422, "对象路径越界")
        if path != self.root and self._is_reserved(relative):
            raise DomainError(403, "Portal 内部对象不可作为数据目录对象")
        return path

    @staticmethod
    def _is_reserved(relative: str) -> bool:
        parts = [part for part in str(relative).replace("\\", "/").split("/") if part]
        return bool(parts and parts[0] in RESERVED_ROOT_NAMES)

    def _visible(self, entry: Path, parent_relative: str) -> bool:
        relative = (Path(parent_relative) / entry.name).as_posix() if parent_relative else entry.name
        return not self._is_reserved(relative)


def _offset(cursor: str | None) -> int:
    try:
        value = int(cursor or 0)
    except ValueError as exc:
        raise DomainError(422, "无效的分页游标") from exc
    if value < 0:
        raise DomainError(422, "无效的分页游标")
    return value


def _capability(provider: str, kinds: list[str]) -> dict[str, Any]:
    return {"provider": provider, "available": True,
            "operations": {"browse": True, "search": True, "inspect_schema": True, "preview_rows": True},
            "object_kinds": kinds, "structured_formats": sorted(set(STRUCTURED.values())),
            "pagination": {"supported": True}}
