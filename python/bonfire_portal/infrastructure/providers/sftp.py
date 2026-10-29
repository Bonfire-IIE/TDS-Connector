from __future__ import annotations

import posixpath
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import paramiko

from ...domain.catalog import DataObject, InspectionResult, ObjectPage
from ...domain.errors import DomainError
from ..inspection import inspect_path, workbook_sheets
from ..object_refs import decode_ref, encode_ref
from .ftp import _capability, _offset, _relative
from .local import STRUCTURED, TRANSFERABLE_FORMATS


class SftpProvider:
    name = "sftp"

    def __init__(self, source: dict[str, Any], max_inspect_bytes: int, excel_max_bytes: int):
        info = source.get("info", {}); options = info.get("options", {})
        self.root = str(info.get("path") or source.get("uri") or "/").rstrip("/") or "/"
        self.host = str(options.get("host") or ""); self.port = int(options.get("port") or 22)
        self.user = str(options.get("user") or ""); self.password = str(options.get("password") or "")
        self.max_inspect_bytes = max_inspect_bytes; self.excel_max_bytes = excel_max_bytes
        if not self.host or not self.user or not self.password or not self.root.startswith("/"):
            raise DomainError(422, "SFTP 数据源配置不完整")

    def _connect(self):
        transport = paramiko.Transport((self.host, self.port)); transport.banner_timeout = 15
        transport.connect(username=self.user, password=self.password)
        return transport, paramiko.SFTPClient.from_transport(transport)

    def capability(self) -> dict[str, Any]:
        transport, client = self._connect()
        try: client.stat(self.root)
        finally: client.close(); transport.close()
        return _capability("sftp")

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
        relative = _relative(locator); transport, client = self._connect()
        try: rows = sorted(client.listdir_attr(self._remote(relative)), key=lambda row: row.filename.casefold())
        finally: client.close(); transport.close()
        start = _offset(cursor)
        items = [self._object(relative, row, parent_ref) for row in rows[start:start + limit]]
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

    def _object(self, parent: str, row: Any, parent_ref: str | None) -> DataObject:
        relative = posixpath.join(parent, row.filename).strip("/")
        if stat.S_ISDIR(row.st_mode):
            return DataObject(encode_ref(self.name, {"kind": "directory", "path": relative}), "directory",
                              row.filename, relative, parent_ref, False, True)
        fmt = STRUCTURED.get(Path(relative).suffix.lower()); kind = "workbook" if fmt == "xlsx" else "file"
        modified = datetime.fromtimestamp(row.st_mtime, timezone.utc).isoformat() if row.st_mtime else None
        return DataObject(encode_ref(self.name, {"kind": kind, "path": relative}), kind, row.filename, relative,
                          parent_ref, kind != "workbook", kind == "workbook", "structured" if fmt else "unstructured",
                          fmt or "binary", row.st_size, modified, bool(fmt), fmt in TRANSFERABLE_FORMATS)

    def _remote(self, relative: str) -> str:
        relative = relative.strip("/")
        if "\\" in relative or ".." in relative.split("/"): raise DomainError(422, "对象路径越界")
        return posixpath.join(self.root, relative)

    def _download(self, relative: str, maximum: int) -> Path:
        transport, client = self._connect(); remote = self._remote(relative)
        handle = tempfile.NamedTemporaryFile(prefix="bonfire-inspect-", suffix=Path(relative).suffix, delete=False)
        try:
            size = client.stat(remote).st_size
            if size > maximum: raise DomainError(413, f"文件大小 {size} 超过结构探测上限 {maximum}")
            handle.close(); client.get(remote, handle.name); return Path(handle.name)
        except Exception:
            handle.close(); Path(handle.name).unlink(missing_ok=True); raise
        finally: client.close(); transport.close()
