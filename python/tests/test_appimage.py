from pathlib import Path

import pytest

from bonfire_portal.application.appimage import ApplicationImageService
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.infrastructure.state import PortalState


def definition() -> dict:
    return {
        "name": "generic-app",
        "display_name": "Generic app",
        "description": "test",
        "capability": "mpc",
        "operations": ["process"],
        "uc_capabilities": ["ephemeral"],
        "registry_source": "third_party",
        "registry": "ghcr.io",
        "image_name": "ghcr.io/example/generic",
        "image_tag": "v1",
        "deploy_templates": [{"name": "party", "role": "party", "containers": []}],
        "config_templates": {},
        "job_template": {"schedule_mode": "Strict"},
        "io_schema": {"inputs": [{"name": "source", "formats": ["csv"]}], "outputs": []},
        "party_schema": {"roles": ["party"]},
        "parameter_schema": {"type": "object"},
        "ui_schema": {"source": {"ui:widget": "resource"}},
        "task_input_template": {"input": "{{inputs.source.relative_uri}}"},
        "scope": "custom",
        "status": "registered",
    }


def service(tmp_path: Path) -> ApplicationImageService:
    database = Database(tmp_path / "portal.sqlite")
    return ApplicationImageService(database, PortalState(database))


def test_appimage_persists_complete_platform_contract(tmp_path: Path):
    appimages = service(tmp_path)
    row = appimages.register({"appimage": definition()})
    stored = appimages.database.application_image("generic-app")

    for field in (
        "display_name", "description", "capability", "operations", "uc_capabilities",
        "registry_source", "registry", "image_name", "image_tag", "deploy_templates",
        "config_templates", "job_template", "io_schema", "party_schema",
        "parameter_schema", "ui_schema", "task_input_template", "scope", "status",
    ):
        assert stored[field] == row[field]


def test_appimage_rejects_unknown_template_port(tmp_path: Path):
    value = definition()
    value["task_input_template"] = {"input": "{{inputs.missing.relative_uri}}"}

    with pytest.raises(DomainError, match="未声明的inputs端口"):
        service(tmp_path).register(value)


def test_appimage_without_inputs_does_not_require_task_template(tmp_path: Path):
    value = definition()
    value["io_schema"] = {"inputs": [], "outputs": [{"name": "result", "formats": ["json"]}]}
    value.pop("task_input_template")

    assert service(tmp_path).register(value)["task_input_template"] is None
