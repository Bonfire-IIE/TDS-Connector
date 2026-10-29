from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from ..domain.errors import DomainError
from ..infrastructure.database import Database
from ..infrastructure.kuscia import LiteClient
from ..infrastructure.state import PortalState


def _validate_contract(value: dict[str, Any], task_input_template: Any) -> None:
    deploy_templates = value.get("deploy_templates")
    if not isinstance(deploy_templates, list) or not deploy_templates:
        raise DomainError(422, "AppImage 定义缺少 deploy_templates")
    io_schema = value.get("io_schema") if isinstance(value.get("io_schema"), dict) else {}
    ports: dict[str, set[str]] = {}
    for direction in ("inputs", "outputs"):
        definitions = io_schema.get(direction) or []
        if not isinstance(definitions, list):
            raise DomainError(422, f"AppImage {direction} 必须是数组")
        names = {
            str(item.get("name") or "")
            for item in definitions
            if isinstance(item, dict)
        }
        if "" in names or len(names) != len(definitions):
            raise DomainError(422, f"AppImage {direction} 端口必须有唯一名称")
        ports[direction] = names
    if ports["inputs"] and task_input_template is None:
        raise DomainError(422, "声明输入端口的 AppImage 必须提供 task_input_template")

    def scan(item: Any) -> None:
        if isinstance(item, dict):
            for child in item.values():
                scan(child)
        elif isinstance(item, list):
            for child in item:
                scan(child)
        elif isinstance(item, str):
            for path in re.findall(r"\{\{\s*([^{}]+?)\s*\}\}", item):
                parts = path.strip().split(".")
                if len(parts) > 1 and parts[0] in ports and parts[1] not in ports[parts[0]]:
                    raise DomainError(422, f"task_input_template 引用了未声明的{parts[0]}端口: {parts[1]}")
                if any(part.lower() in {"secret", "password", "token", "private_key", "access_key_secret", "ak", "sk"} for part in parts):
                    raise DomainError(422, f"task_input_template 不允许引用秘密字段: {path}")

    scan(task_input_template)


class ApplicationImageService:
    def __init__(self, database: Database, state: PortalState):
        self.database, self.state = database, state

    def register(self, body: dict[str, Any]) -> dict[str, Any]:
        value = body.get("appimage") if isinstance(body.get("appimage"), dict) else body
        if not value.get("name") or not value.get("image_name") or not value.get("image_tag"):
            raise DomainError(422, "AppImage 定义缺少 name、image_name 或 image_tag")
        task_input_template = body.get("task_input_template", value.get("task_input_template"))
        _validate_contract(value, task_input_template)
        row = {"name": str(value["name"]),
               "display_name": str(value.get("display_name") or value["name"]),
               "description": value.get("description"),
               "capability": str(value.get("capability") or "general"),
               "operations": value.get("operations") if isinstance(value.get("operations"), list) else [],
               "uc_capabilities": value.get("uc_capabilities") if isinstance(value.get("uc_capabilities"), list) else [],
               "registry_source": str(value.get("registry_source") or "third_party"),
               "registry": value.get("registry"),
               "scope": str(value.get("scope") or "custom"),
               "status": str(value.get("status") or "registered"),
               "image_name": str(value["image_name"]), "image_tag": str(value["image_tag"]),
               "deploy_templates": value.get("deploy_templates") if isinstance(value.get("deploy_templates"), list) else [],
               "config_templates": value.get("config_templates") if isinstance(value.get("config_templates"), dict) else {},
               "job_template": value.get("job_template") if isinstance(value.get("job_template"), dict) else {},
               "io_schema": value.get("io_schema") if isinstance(value.get("io_schema"), dict) else {},
               "party_schema": value.get("party_schema") if isinstance(value.get("party_schema"), dict) else {},
               "parameter_schema": value.get("parameter_schema") if isinstance(value.get("parameter_schema"), dict) else {},
               "ui_schema": value.get("ui_schema") if isinstance(value.get("ui_schema"), dict) else {},
               "task_input_template": task_input_template,
               "registered_at": datetime.now(timezone.utc).isoformat()}
        self.database.save_application_image(row)
        return row

    async def register_and_publish(self, body: dict[str, Any], connector_id: str) -> dict[str, Any]:
        profile = self.state.profile(connector_id)
        if profile and profile.get("scheduling_mode") == "master-lite":
            raise DomainError(409, "Master-Lite 应用由中心登记并分发，连接器不发布 AppImage")
        row = self.register(body)
        published = False
        if profile and profile.get("lite_kuscia_endpoint") and profile.get("lite_cert_dir"):
            await LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"]).publish_appimage(row)
            published = True
        return {"name": row["name"], "registered": True, "published": published,
                "registered_at": row["registered_at"]}

    def list(self, connector_id: str) -> list[dict[str, Any]]:
        if not self.state.profile(connector_id):
            raise DomainError(404, "本地连接器配置不存在")
        return self.database.application_images()
