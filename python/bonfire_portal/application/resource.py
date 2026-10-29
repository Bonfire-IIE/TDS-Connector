from __future__ import annotations

import re
import uuid
import asyncio
from datetime import datetime, timezone
from typing import Any

from .catalog import CatalogService
from ..config import Settings

from ..domain.errors import DomainError
from ..domain.types import standard_type
from ..infrastructure.database import Database
from ..infrastructure.object_refs import decode_ref
from ..infrastructure.platform import PlatformClient


STATUSES = {"registered", "pending_review", "published", "rejected", "delisted"}
SECURITY_LEVELS = {"general_1", "general_2", "important"}
DATA_TYPES = {"table", "file", "text", "image", "other"}
RESOURCE_FORMATS = {"CSV", "TSV", "JSON", "JSONL", "PARQUET", "ORC", "TABLE", "XLSX", "BINARY"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def validate_registration(body: dict[str, Any]) -> dict[str, Any]:
    required = (
        "resource_name", "resource_abstract", "industry_code", "resource_owner_name",
        "resource_owner_id", "contact_name", "contact_information", "resource_format",
        "data_source_type", "update_frequency", "personal_information_level",
        "security_level", "datasource_id", "relative_uri",
        "data_type",
    )
    if any(not str(body.get(name) or "").strip() for name in required):
        raise DomainError(422, "缺少标准数据资源必填信息")

    value = dict(body)
    industry = str(value["industry_code"]).upper()
    theme = str(value.get("theme_code") or "").upper() or None
    if not re.fullmatch(r"[A-T]", industry):
        raise DomainError(422, "行业分类必须使用 GB/T 4754 门类代码 A-T")
    if theme and not re.fullmatch(r"Z[A-W](?:[A-Z]00)?", theme):
        raise DomainError(422, "政务主题分类必须使用 GB/T 21063.4 一级或二级代码")
    if str(value["security_level"]) not in SECURITY_LEVELS:
        raise DomainError(422, "数据安全等级只能为一般一级、一般二级或重要")
    if not re.fullmatch(r"[012]", str(value["personal_information_level"])):
        raise DomainError(422, "个人信息分类代码必须为 0、1 或 2")
    if not re.fullmatch(r"(?:01|02|03|04|05)", str(value["data_source_type"])):
        raise DomainError(422, "数据来源代码必须为 01-05")
    frequency = str(value["update_frequency"]).strip()
    if not re.fullmatch(r"(?:不更新|其他|[1-9]\d*(?:\.\d+)?次/(?:天|周|月|季度|年))", frequency):
        raise DomainError(422, "更新频率应为次数/周期（如 1次/月）、不更新或其他")
    if len(str(value["contact_name"])) > 10 or not re.fullmatch(r"\d{11}", str(value["contact_information"])):
        raise DomainError(422, "联系人不超过 10 个字符，联系方式应为 11 位号码")
    items = value.get("data_items") or []
    if not isinstance(items, list):
        raise DomainError(422, "data_items 必须是数组")
    data_type = str(value["data_type"])
    if data_type not in DATA_TYPES:
        raise DomainError(422, "数据类型只能为 table、file、text、image 或 other")
    if data_type == "table" and not items:
        raise DomainError(422, "表格类数据资源必须提供列定义")
    if data_type != "table" and items:
        raise DomainError(422, "只有表格类数据资源可以配置列定义")
    resource_format = str(value["resource_format"]).strip().upper()
    if resource_format not in RESOURCE_FORMATS:
        raise DomainError(422, "资源格式不在平台支持的标准格式中")
    normalized_items = []
    names: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise DomainError(422, "data_items 中的字段定义必须是对象")
        name = str(item.get("name") or "").strip()
        if not name:
            raise DomainError(422, "表格列名不能为空")
        if name in names:
            raise DomainError(422, f"表格列名重复: {name}")
        names.add(name)
        normalized_items.append({**item, "name": name, "type": standard_type(item.get("type") or "string")})
    value.update({
        "industry_code": industry, "theme_code": theme,
        "data_modalities": value.get("data_modalities") or [],
        "ai_task_types": value.get("ai_task_types") or [],
        "data_items": normalized_items,
        "resource_name": str(value["resource_name"]).strip(),
        "resource_abstract": str(value["resource_abstract"]).strip(),
        "update_frequency": frequency,
        "resource_format": resource_format,
    })
    return value


class ResourceService:
    def __init__(self, database: Database, catalog: CatalogService | None = None, settings: Settings | None = None):
        self.database, self.catalog, self.settings = database, catalog, settings

    def prepare_registration(self, body: dict[str, Any], connector_id: str) -> dict[str, Any]:
        """Resolve a catalog object into the canonical connector resource input."""
        object_ref = str(body.get("object_ref") or "")
        if not object_ref:
            return body
        source_id = str(body.get("datasource_id") or "")
        source = self.database.datasource(source_id, connector_id)
        if not source:
            raise DomainError(404, "所选数据源不存在于当前连接器")
        provider_name = {"localfs": "localfs", "oss": "oss", "ftp": "ftp", "sftp": "sftp", "jdbc": "jdbc"}.get(source.get("type"))
        locator = decode_ref(object_ref, provider_name)
        relative = str(locator.get("path") or "")
        if not relative and locator.get("name"):
            relative = ".".join(str(item) for item in (locator.get("schema"), locator.get("name")) if item)
        if not relative:
            raise DomainError(422, "所选目录对象不能登记为数据资源")
        value = {**body, "relative_uri": relative}
        if value.get("resource_format") and value.get("data_items") is not None:
            return value
        if not self.catalog or not self.settings:
            raise DomainError(500, "数据目录服务尚未装配")
        result = self.catalog.inspect(source_id, connector_id, object_ref, self.settings.catalog_sample_rows, {})
        value["data_items"] = value.get("data_items") or [{"name": column.name, "type": column.type} for column in result.columns]
        value["resource_format"] = value.get("resource_format") or result.format
        return value

    def list(self, connector_id: str) -> list[dict[str, Any]]:
        return self.database.resources(connector_id)

    def sync(self, connector_id: str, projections: list[dict[str, Any]]) -> list[dict[str, Any]]:
        remote = {str(item.get("id") or item.get("resource_id") or ""): item for item in projections if isinstance(item, dict)}
        result = []
        for resource in self.list(connector_id):
            projection = remote.get(str(resource["id"]))
            status = str((projection or {}).get("status") or "")
            if projection and status in {"pending_review", "published", "rejected", "delisted"}:
                comment = projection.get("review_comment")
                if resource.get("status") != status or resource.get("review_comment") != comment:
                    resource = self.database.save_resource({**resource, "status": status,
                        "review_comment": comment, "updated_at": _now()})
            result.append(resource)
        return result

    def register(self, body: dict[str, Any], connector_id: str) -> dict[str, Any]:
        value = validate_registration(body)
        if not self.database.datasource(str(value["datasource_id"]), connector_id):
            raise DomainError(400, "所选数据源不存在于当前连接器")
        now = _now()
        resource_id = str(value.get("resource_id") or uuid.uuid4())
        resource = {**value, "id": resource_id, "connector_id": connector_id,
                    "resource_code": str(value.get("resource_code") or resource_id),
                    "status": "registered", "review_comment": None,
                    "created_at": now, "updated_at": now}
        return self.database.save_resource(resource)

    def update(self, resource_id: str, body: dict[str, Any], connector_id: str) -> dict[str, Any]:
        current = self.database.resource(resource_id, connector_id)
        if not current:
            raise DomainError(404, "连接器资源不存在")
        if current["status"] not in {"registered", "rejected"}:
            raise DomainError(409, "待审核或已上架资源不能直接修改")
        value = validate_registration({**body, "resource_id": resource_id})
        if not self.database.datasource(str(value["datasource_id"]), connector_id):
            raise DomainError(400, "所选数据源不存在于当前连接器")
        return self.database.save_resource({**value, "id": resource_id, "connector_id": connector_id,
            "resource_code": current.get("resource_code") or resource_id, "status": current["status"],
            "review_comment": current.get("review_comment"), "created_at": current["created_at"], "updated_at": _now()})

    def remove(self, resource_id: str, connector_id: str, remote_removed: bool = False) -> str:
        current = self.database.resource(resource_id, connector_id)
        if not current:
            raise DomainError(404, "连接器资源不存在")
        if current["status"] == "pending_review" and not remote_removed:
            raise DomainError(409, "待审核资源不能删除")
        self.database.delete_resource(resource_id, connector_id)
        return resource_id

    def mark_pending(self, resource: dict[str, Any], projection: dict[str, Any] | None = None) -> dict[str, Any]:
        updated = {**resource, "status": "pending_review", "updated_at": _now()}
        if projection:
            updated["resource_code"] = str(projection.get("tds_code") or updated.get("resource_code") or resource["id"])
        return self.database.save_resource(updated)

    async def list_synced(self, connector_id: str, authorization: str | None) -> list[dict[str, Any]]:
        if not self.settings:
            raise DomainError(500, "资源服务尚未装配中心配置")
        remote = await PlatformClient(self.settings, authorization).list_resources(connector_id)
        return self.sync(connector_id, remote if isinstance(remote, list) else [])

    async def register_from_request(self, body: dict[str, Any], connector_id: str) -> dict[str, Any]:
        prepared = await asyncio.to_thread(self.prepare_registration, body, connector_id)
        return self.register(prepared, connector_id)

    async def update_from_request(self, resource_id: str, body: dict[str, Any],
                                  connector_id: str) -> dict[str, Any]:
        prepared = await asyncio.to_thread(self.prepare_registration, body, connector_id)
        return self.update(resource_id, prepared, connector_id)

    async def delete_projected(self, resource_id: str, connector_id: str,
                               authorization: str | None) -> str:
        current = self.database.resource(resource_id, connector_id)
        if not current:
            raise DomainError(404, "连接器资源不存在")
        removed_remote = current.get("status") != "registered"
        if removed_remote:
            if not self.settings:
                raise DomainError(500, "资源服务尚未装配中心配置")
            await PlatformClient(self.settings, authorization).delete_resource(resource_id)
        return self.remove(resource_id, connector_id, removed_remote)

    async def publish(self, resource_id: str, connector_id: str,
                      authorization: str | None) -> dict[str, Any]:
        resource = self.database.resource(resource_id, connector_id)
        if not resource:
            raise DomainError(404, "连接器资源不存在")
        if resource["status"] == "published":
            return {"resource": resource, "catalog": resource}
        if not self.settings:
            raise DomainError(500, "资源服务尚未装配中心配置")
        source = self.database.datasource(str(resource.get("datasource_id") or ""), connector_id)
        if not source:
            raise DomainError(409, "资源引用的数据源已不存在")
        projection = await PlatformClient(self.settings, authorization).publish_resource(
            {
                **resource,
                "resource_id": resource["id"],
                "source_connector_id": connector_id,
                "datasource_name": source.get("name"),
                "datasource_type": source.get("type"),
                "datasource_uri": source.get("uri"),
            }
        )
        updated = self.mark_pending(resource, projection if isinstance(projection, dict) else None)
        return {"resource": updated, "catalog": projection}
