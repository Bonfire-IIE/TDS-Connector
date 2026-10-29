from __future__ import annotations

import ftplib
import posixpath
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ...domain.catalog import DataObject, InspectionResult, ObjectPage
from ...domain.errors import DomainError
from ..inspection import inspect_path, workbook_sheets
from ..object_refs import decode_ref, encode_ref
from .local import STRUCTURED, TRANSFERABLE_FORMATS


class FtpProvider:
    name = "ftp"

    def __init__(self, source: dict[str, Any], max_inspect_bytes: int, excel_max_bytes: int):
        info = source.get("info", {}); options = info.get("options", {})
        self.root = str(info.get("path") or source.get("uri") or "/").rstrip("/") or "/"
        self.host = str(options.get("host") or ""); self.port = int(options.get("port") or 21)
        self.user = str(options.get("user") or ""); self.password = str(options.get("password") or "")
        self.max_inspect_bytes = max_inspect_bytes; self.excel_max_bytes = excel_max_bytes
        if not self.host or not self.user or not self.password or not self.root.startswith("/"):
            raise DomainError(422, "FTP 数据源配置不完整")

    def _connect(self) -> ftplib.FTP:
        client = ftplib.FTP()
        client.connect(self.host, self.port, timeout=15)
        client.login(self.user, self.password)
        client.set_pasv(True)
        return client

    def capability(self) -> dict[str, Any]:
        with self._connect() as client: client.cwd(self.root)
        return _capability("ftp")

    def list_objects(self, parent_ref: str | None, cursor: str | None, limit: int) -> ObjectPage:
        locator = decode_ref(parent_ref, self.name) if parent_ref else {"kind": "directory", "path": ""}
        if locator.get("kind") == "workbook":
            temporary = self._download(str(locator["path"]), self.excel_max_bytes)
            try: names = workbook_sheets(temporary)
            finally: temporary.unlink(missing_ok=True)
            start = _offset(cursor)
            items = [DataObject(encode_ref(self.name, {"kind": "sheet", "path": locator["path"], "sheet": name}),
                                "sheet", name, f"{locator['path']}#{name}", parent_ref, True, False,
                                "structured", "xlsx", inspectable=True) for name in names[start:start + limit]]
            nxt = str(start + limit) if start + limit < len(names) else None
            return ObjectPage(items, nxt, bool(nxt))
        relative = _relative(locator)
        directory = self._remote(relative)
        with self._connect() as client:
            try:
                rows = list(client.mlsd(directory, facts=["type", "size", "modify"]))
            except (ftplib.error_perm, AttributeError):
                rows = [(name, {"type": "unknown"}) for name in client.nlst(directory)]
        rows.sort(key=lambda row: row[0].casefold())
        start = _offset(cursor)
        items = [self._object(relative, name, facts, parent_ref) for name, facts in rows[start:start + limit]
                 if name not in {".", ".."}]
        nxt = str(start + limit) if start + limit < len(rows) else None
        return ObjectPage(items, nxt, bool(nxt))

    def inspect(self, object_ref: str, sample_rows: int, options: dict[str, Any]) -> InspectionResult:
        locator = decode_ref(object_ref, self.name); relative = str(locator.get("path") or "")
        limit = self.excel_max_bytes if Path(relative).suffix.lower() in {".xlsx", ".xlsm"} else self.max_inspect_bytes
        temporary = self._download(relative, limit)
        try:
            merged = {**options, **({"sheet": locator["sheet"]} if locator.get("sheet") else {})}
            return inspect_path(temporary, object_ref, sample_rows, merged)
        finally: temporary.unlink(missing_ok=True)

    def walk(self):
        stack: list[tuple[str, str | None]] = [("", None)]
        while stack:
            relative, parent = stack.pop(); cursor = None
            while True:
                ref = encode_ref(self.name, {"kind": "directory", "path": relative}) if relative else None
                page = self.list_objects(ref, cursor, 500)
                for item in page.items:
                    yield item
                    if item.kind == "directory": stack.append((item.path, item.object_ref))
                if not page.next_cursor: break
                cursor = page.next_cursor

    def _object(self, parent: str, name: str, facts: dict[str, str], parent_ref: str | None) -> DataObject:
        clean_name = posixpath.basename(name.rstrip("/")); relative = posixpath.join(parent, clean_name).strip("/")
        is_dir = facts.get("type") == "dir"
        if facts.get("type") == "unknown":
            with self._connect() as client:
                try: client.cwd(self._remote(relative)); is_dir = True
                except ftplib.error_perm: is_dir = False
        if is_dir:
            return DataObject(encode_ref(self.name, {"kind": "directory", "path": relative}), "directory",
                              clean_name, relative, parent_ref, False, True)
        fmt = STRUCTURED.get(Path(relative).suffix.lower()); size = int(facts.get("size") or 0) or None
        modified = _ftp_time(facts.get("modify"))
        kind = "workbook" if fmt == "xlsx" else "file"
        return DataObject(encode_ref(self.name, {"kind": kind, "path": relative}), kind, clean_name, relative,
                          parent_ref, kind != "workbook", kind == "workbook", "structured" if fmt else "unstructured",
                          fmt or "binary", size, modified, bool(fmt), fmt in TRANSFERABLE_FORMATS)

    def _remote(self, relative: str) -> str:
        relative = relative.strip("/")
        if "\\" in relative or ".." in relative.split("/"): raise DomainError(422, "对象路径越界")
        return posixpath.join(self.root, relative)

    def _download(self, relative: str, maximum: int) -> Path:
        remote = self._remote(relative); suffix = Path(relative).suffix
        with self._connect() as client:
            size = client.size(remote)
            if size is not None and size > maximum: raise DomainError(413, f"文件大小 {size} 超过结构探测上限 {maximum}")
            handle = tempfile.NamedTemporaryFile(prefix="bonfire-inspect-", suffix=suffix, delete=False)
            total = 0
            try:
                with handle:
                    def write(chunk: bytes):
                        nonlocal total
                        total += len(chunk)
                        if total > maximum: raise DomainError(413, f"文件超过结构探测上限 {maximum}")
                        handle.write(chunk)
                    client.retrbinary(f"RETR {remote}", write)
                return Path(handle.name)
            except Exception:
                Path(handle.name).unlink(missing_ok=True); raise


def _relative(locator: dict[str, Any]) -> str:
    if locator.get("kind") != "directory": raise DomainError(422, "该对象不能展开")
    value = str(locator.get("path") or "").strip("/")
    if "\\" in value or ".." in value.split("/"): raise DomainError(422, "对象路径越界")
    return value


def _offset(cursor: str | None) -> int:
    try: return max(int(cursor or 0), 0)
    except ValueError as exc: raise DomainError(422, "无效的分页游标") from exc


def _ftp_time(value: str | None) -> str | None:
    if not value: return None
    try: return datetime.strptime(value, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).isoformat()
    except ValueError: return None


def _capability(provider: str) -> dict[str, Any]:
    return {"provider": provider, "available": True,
            "operations": {"browse": True, "search": True, "inspect_schema": True, "preview_rows": True},
            "object_kinds": ["directory", "file", "workbook", "sheet"],
            "structured_formats": sorted(set(STRUCTURED.values())), "pagination": {"supported": True}}
