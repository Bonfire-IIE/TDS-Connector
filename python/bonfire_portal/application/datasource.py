from __future__ import annotations

"""Application service for connector-local data-source registration."""

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from ..config import Settings
from ..domain.errors import DomainError
from ..infrastructure.database import Database


class DataSourceApplicationService:
    def __init__(self, database: Database, settings: Settings):
        self.database, self.settings = database, settings

    def list(self, connector_id: str, publicize) -> list[dict[str, Any]]:
        return [publicize(item) for item in self.database.datasources(connector_id)]

    def register(self, body: dict[str, Any], connector_id: str, publicize) -> dict[str, Any]:
        name, kind = str(body.get("name") or "").strip(), str(body.get("type") or "")
        if not name or kind not in {"localfs", "oss", "ftp", "sftp", "jdbc"}:
            raise DomainError(422, "需要有效的数据源名称和类型")
        info = body.get("info") if isinstance(body.get("info"), dict) else {}
        options = info.get("options") if isinstance(info.get("options"), dict) else {}
        uri = body.get("uri")
        if kind == "localfs":
            raw = str(info.get("path") or uri or "")
            if not raw.startswith("/"):
                raise DomainError(422, "本地文件数据源需要绝对目录")
            root, resolved = self.settings.storage_root.resolve(), Path(raw).resolve()
            if resolved != root and root not in resolved.parents:
                raise DomainError(422, f"本地文件数据源必须位于受控目录 {root}")
            info, uri = {**info, "path": str(resolved)}, str(resolved)
        elif kind == "oss":
            endpoint, bucket = str(info.get("endpoint") or ""), str(info.get("bucket") or "")
            parsed = urlparse(endpoint)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                raise DomainError(422, "OSS 服务端点必须是有效的 HTTP(S) URL")
            if not bucket or not info.get("access_key_id") or not info.get("access_key_secret"):
                raise DomainError(422, "OSS 数据源必须配置 Bucket、Access Key 和 Secret Key")
            prefix = str(info.get("prefix") or "").strip("/")
            info, uri = {**info, "prefix": prefix}, uri or f"{endpoint.rstrip('/')}/{bucket}" + (f"/{prefix}" if prefix else "")
        elif kind in {"ftp", "sftp"}:
            root = str(info.get("path") or "")
            try:
                port = int(options.get("port") or (21 if kind == "ftp" else 22))
            except (TypeError, ValueError) as exc:
                raise DomainError(422, f"{kind.upper()} 端口无效") from exc
            if (not options.get("host") or not options.get("user") or not options.get("password")
                    or not root.startswith("/") or ".." in root.split("/") or "\\" in root
                    or port < 1 or port > 65535):
                raise DomainError(422, f"{kind.upper()} 源需要主机、端口、用户名、密码和服务端绝对根目录")
            info, uri = {**info, "options": {**options, "port": port}}, f"connector://{kind}"
        else:
            if not options.get("url") or not options.get("driver"):
                raise DomainError(422, "JDBC 源需要 url 和 driver")
            # A datasource describes a database connection, not a fixed query.
            # The selected catalog table/view determines the execution query.
            options = {key: value for key, value in options.items() if key != "query"}
            info, uri = {**info, "options": options}, "connector://jdbc"
        source_id = "ds-" + str(uuid.uuid4())
        source = {"id": source_id, "connector_id": connector_id, "name": name, "type": kind,
                  "uri": uri, "info": info, "created_at": datetime.now(timezone.utc).isoformat()}
        self.database.connection().execute(
            "INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
            (source_id, connector_id, json.dumps(source), source["created_at"]),
        )
        return publicize(source)

    def delete(self, datasource_id: str, connector_id: str, has_resources: bool) -> str:
        if not self.database.datasource(datasource_id, connector_id):
            raise DomainError(404, "数据源不存在")
        if has_resources:
            raise DomainError(409, "数据源仍被数据资源引用，不能删除")
        self.database.connection().execute("DELETE FROM datasource WHERE id=? AND connector_id=?", (datasource_id, connector_id))
        return datasource_id

    def delete_registered(self, datasource_id: str, connector_id: str) -> str:
        source = self.database.datasource(datasource_id, connector_id)
        if not source:
            raise DomainError(404, "数据源不存在")
        referenced = any(
            item.get("datasource_id") == datasource_id
            for item in self.database.resources(connector_id)
        )
        if referenced:
            raise DomainError(409, "数据源仍被数据资源引用，不能删除")
        return self.delete(datasource_id, connector_id, False)
