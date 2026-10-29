from __future__ import annotations

import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config

from ...domain.catalog import DataObject, InspectionResult, ObjectPage
from ...domain.errors import DomainError
from ..inspection import inspect_path, workbook_sheets
from ..object_refs import decode_ref, encode_ref
from .local import STRUCTURED, TRANSFERABLE_FORMATS


class S3Provider:
    name = "oss"

    def __init__(self, source: dict[str, Any], max_inspect_bytes: int, excel_max_bytes: int):
        info = source.get("info", {})
        self.bucket = str(info.get("bucket") or "")
        self.root = str(info.get("prefix") or "").strip("/")
        self.max_inspect_bytes = max_inspect_bytes
        self.excel_max_bytes = excel_max_bytes
        if not self.bucket or not info.get("endpoint"):
            raise DomainError(422, "OSS 数据源缺少 endpoint 或 bucket")
        self.client = boto3.client("s3", endpoint_url=str(info["endpoint"]),
            aws_access_key_id=str(info.get("access_key_id") or ""),
            aws_secret_access_key=str(info.get("access_key_secret") or ""),
            config=Config(signature_version="s3v4", s3={"addressing_style": "virtual" if info.get("virtualhost") else "path"}),
            verify=bool(info.get("verify_tls", True)))

    def capability(self) -> dict[str, Any]:
        self.client.head_bucket(Bucket=self.bucket)
        return {"provider": "oss", "available": True,
                "operations": {"browse": True, "search": True, "inspect_schema": True, "preview_rows": True},
                "object_kinds": ["directory", "file", "workbook", "sheet"],
                "structured_formats": sorted(set(STRUCTURED.values())), "pagination": {"supported": True}}

    def list_objects(self, parent_ref: str | None, cursor: str | None, limit: int) -> ObjectPage:
        locator = decode_ref(parent_ref, self.name) if parent_ref else {"kind": "directory", "path": ""}
        if locator.get("kind") == "workbook":
            path = str(locator["path"])
            local = self._download(path, self.excel_max_bytes)
            try:
                names = workbook_sheets(local)
            finally:
                local.unlink(missing_ok=True)
            start = int(cursor or 0)
            items = [DataObject(encode_ref(self.name, {"kind": "sheet", "path": path, "sheet": name}), "sheet", name,
                                f"{path}#{name}", parent_ref, True, False, "structured", "xlsx", inspectable=True)
                     for name in names[start:start + limit]]
            nxt = str(start + limit) if start + limit < len(names) else None
            return ObjectPage(items, nxt, bool(nxt))
        if locator.get("kind") != "directory": raise DomainError(422, "该对象不能展开")
        relative = str(locator.get("path") or "").strip("/")
        prefix = "/".join(item for item in (self.root, relative) if item)
        if prefix: prefix += "/"
        request: dict[str, Any] = {"Bucket": self.bucket, "Prefix": prefix, "Delimiter": "/", "MaxKeys": limit}
        if cursor: request["ContinuationToken"] = cursor
        response = self.client.list_objects_v2(**request)
        items: list[DataObject] = []
        for item in response.get("CommonPrefixes", []):
            path = str(item["Prefix"])[len(self.root):].strip("/")
            items.append(DataObject(encode_ref(self.name, {"kind": "directory", "path": path}), "directory",
                                    path.rsplit("/", 1)[-1], path, parent_ref, False, True))
        for item in response.get("Contents", []):
            key = str(item["Key"])
            if key.endswith("/"): continue
            path = key[len(self.root):].strip("/") if self.root else key
            items.append(self._object(path, int(item.get("Size", 0)), item.get("LastModified"), parent_ref))
        return ObjectPage(items, response.get("NextContinuationToken"), bool(response.get("IsTruncated")))

    def inspect(self, object_ref: str, sample_rows: int, options: dict[str, Any]) -> InspectionResult:
        locator = decode_ref(object_ref, self.name)
        path = str(locator.get("path") or "")
        limit = self.excel_max_bytes if Path(path).suffix.lower() in {".xlsx", ".xlsm"} else self.max_inspect_bytes
        local = self._download(path, limit)
        merged = {**options, **({"sheet": locator["sheet"]} if locator.get("sheet") else {})}
        try:
            return inspect_path(local, object_ref, sample_rows, merged)
        finally:
            local.unlink(missing_ok=True)

    def walk(self):
        cursor = None
        while True:
            request = {"Bucket": self.bucket, "Prefix": self.root + "/" if self.root else "", "MaxKeys": 1000}
            if cursor: request["ContinuationToken"] = cursor
            response = self.client.list_objects_v2(**request)
            for item in response.get("Contents", []):
                key = str(item["Key"])
                if key.endswith("/"): continue
                path = key[len(self.root):].strip("/") if self.root else key
                yield self._object(path, int(item.get("Size", 0)), item.get("LastModified"), None)
            cursor = response.get("NextContinuationToken")
            if not cursor: break

    def _object(self, path: str, size: int, modified: datetime | None, parent_ref: str | None) -> DataObject:
        fmt = STRUCTURED.get(Path(path).suffix.lower())
        stamp = modified.isoformat() if modified else None
        if fmt == "xlsx":
            return DataObject(encode_ref(self.name, {"kind": "workbook", "path": path}), "workbook", Path(path).name,
                              path, parent_ref, False, True, "structured", fmt, size, stamp, True, False)
        return DataObject(encode_ref(self.name, {"kind": "file", "path": path}), "file", Path(path).name, path,
                          parent_ref, True, False, "structured" if fmt else "unstructured", fmt or "binary", size,
                          stamp, bool(fmt), fmt in TRANSFERABLE_FORMATS)

    def _download(self, relative: str, maximum: int) -> Path:
        key = "/".join(item for item in (self.root, relative.strip("/")) if item)
        head = self.client.head_object(Bucket=self.bucket, Key=key)
        size = int(head.get("ContentLength", 0))
        if size > maximum:
            raise DomainError(413, f"对象大小 {size} 超过结构探测上限 {maximum}")
        suffix = Path(relative).suffix
        handle = tempfile.NamedTemporaryFile(prefix="bonfire-inspect-", suffix=suffix, delete=False)
        try:
            with handle:
                self.client.download_fileobj(self.bucket, key, handle)
            return Path(handle.name)
        except Exception:
            Path(handle.name).unlink(missing_ok=True)
            raise
