from pathlib import Path
import json
import sqlite3

import pytest

from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.infrastructure.object_refs import encode_ref
from bonfire_portal.application.resource import ResourceService, validate_registration


def _body() -> dict:
    return {
        "resource_name": "客户标识",
        "resource_abstract": "用于联合分析的客户标识数据",
        "industry_code": "J",
        "theme_code": "ZA",
        "resource_owner_name": "测试机构",
        "resource_owner_id": "ORG-001",
        "contact_name": "张三",
        "contact_information": "13800138000",
        "resource_format": "CSV",
        "data_type": "table",
        "data_source_type": "01",
        "update_frequency": "1次/月",
        "personal_information_level": "1",
        "security_level": "general_2",
        "datasource_id": "ds-1",
        "relative_uri": "data.csv",
        "data_items": [{"name": "id", "type": "string"}],
    }


def test_resource_requires_standard_codes():
    with pytest.raises(DomainError, match="行业分类"):
        validate_registration({**_body(), "industry_code": "ZZ"})
    with pytest.raises(DomainError, match="安全等级"):
        validate_registration({**_body(), "security_level": "core"})


def test_resource_normalizes_seatunnel_column_types():
    value = validate_registration({**_body(), "data_items": [
        {"name": "id", "type": "str"},
        {"name": "amount", "type": "DECIMAL(12, 2)"},
    ]})
    assert value["data_items"] == [
        {"name": "id", "type": "string"},
        {"name": "amount", "type": "decimal(12,2)"},
    ]


def test_resource_rejects_invalid_or_duplicate_column_types():
    with pytest.raises(DomainError, match="不支持的标准字段类型"):
        validate_registration({**_body(), "data_items": [{"name": "id", "type": "object"}]})
    with pytest.raises(DomainError, match="列名重复"):
        validate_registration({**_body(), "data_items": [
            {"name": "id", "type": "string"}, {"name": "id", "type": "bigint"},
        ]})
    with pytest.raises(DomainError, match="资源格式"):
        validate_registration({**_body(), "resource_format": "spreadsheet"})


def test_resource_lifecycle_is_connector_scoped(tmp_path: Path):
    db = Database(tmp_path / "portal.sqlite")
    db.connection().execute(
        "INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-1", "connector-a", '{"id":"ds-1"}', "now"),
    )
    service = ResourceService(db)
    created = service.register(_body(), "connector-a")
    assert created["status"] == "registered"
    assert service.list("connector-b") == []
    updated = service.update(created["id"], {**_body(), "resource_name": "客户标识2"}, "connector-a")
    assert updated["resource_name"] == "客户标识2"
    assert service.remove(created["id"], "connector-a") == created["id"]


def test_catalog_object_is_resolved_before_resource_registration(tmp_path: Path):
    db = Database(tmp_path / "portal.sqlite")
    source = {"id": "ds-1", "connector_id": "connector-a", "type": "localfs", "uri": "/data"}
    db.connection().execute(
        "INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-1", "connector-a", json.dumps(source), "now"),
    )
    object_ref = encode_ref("localfs", {"kind": "file", "path": "incoming/data.csv"})
    service = ResourceService(db)

    prepared = service.prepare_registration({**_body(), "relative_uri": "", "object_ref": object_ref}, "connector-a")

    assert prepared["relative_uri"] == "incoming/data.csv"
    assert prepared["data_items"] == [{"name": "id", "type": "string"}]
    assert prepared["resource_format"] == "CSV"


def test_ftp_catalog_object_is_stored_as_relative_resource_uri(tmp_path: Path):
    db = Database(tmp_path / "portal.sqlite")
    source = {
        "id": "ds-1",
        "connector_id": "connector-a",
        "type": "ftp",
        "info": {"path": "/ftp/bonfire"},
    }
    db.connection().execute(
        "INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-1", "connector-a", json.dumps(source), "now"),
    )
    object_ref = encode_ref("ftp", {"kind": "file", "path": "in/customers.csv"})

    prepared = ResourceService(db).prepare_registration(
        {**_body(), "relative_uri": "", "object_ref": object_ref}, "connector-a"
    )

    assert prepared["relative_uri"] == "in/customers.csv"
    assert prepared["object_ref"] == object_ref


def test_resource_status_is_reconciled_from_center(tmp_path: Path):
    db = Database(tmp_path / "portal.sqlite")
    db.connection().execute("INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-1", "connector-a", '{"id":"ds-1"}', "now"))
    service = ResourceService(db); created = service.register(_body(), "connector-a")
    service.mark_pending(created)
    rows = service.sync("connector-a", [{"id": created["id"], "status": "published", "review_comment": "ok"}])
    assert rows[0]["status"] == "published"
    assert rows[0]["review_comment"] == "ok"


def test_node_resource_table_is_migrated_with_single_profile(tmp_path: Path):
    path = tmp_path / "portal.sqlite"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE portal_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE connector_resource (
          id TEXT PRIMARY KEY, resource_code TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL, status TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        """
    )
    connection.execute(
        "INSERT INTO portal_state(id,payload) VALUES(1,?)",
        (json.dumps({"connectors": {"connector-a": {"connector_id": "connector-a"}}}),),
    )
    resource = {"id": "resource-a", "resource_code": "R-1", "status": "registered"}
    connection.execute(
        "INSERT INTO connector_resource VALUES(?,?,?,?,?,?)",
        ("resource-a", "R-1", json.dumps(resource), "registered", "before", "after"),
    )
    connection.commit()
    connection.close()

    db = Database(path)
    migrated = db.resource("resource-a", "connector-a")
    assert migrated is not None
    assert migrated["connector_id"] == "connector-a"
    assert {row["name"] for row in db.connection().execute("PRAGMA table_info(connector_resource)")} == {
        "id", "connector_id", "payload", "status", "created_at", "updated_at"
    }


def test_ambiguous_node_resource_table_is_not_silently_reassigned(tmp_path: Path):
    path = tmp_path / "portal.sqlite"
    connection = sqlite3.connect(path)
    connection.executescript(
        """
        CREATE TABLE portal_state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
        CREATE TABLE connector_resource (
          id TEXT PRIMARY KEY, resource_code TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL, status TEXT NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        """
    )
    connection.execute(
        "INSERT INTO portal_state(id,payload) VALUES(1,?)",
        (json.dumps({"connectors": {"a": {"connector_id": "a"}, "b": {"connector_id": "b"}}}),),
    )
    connection.execute(
        "INSERT INTO connector_resource VALUES(?,?,?,?,?,?)",
        ("resource-a", "R-1", '{"id":"resource-a"}', "registered", "before", "after"),
    )
    connection.commit()
    connection.close()

    with pytest.raises(RuntimeError, match="cannot be assigned"):
        Database(path)


def test_legacy_appimage_registry_is_imported_once(tmp_path: Path):
    (tmp_path / "appimages.json").write_text(json.dumps({"psi": {
        "name": "psi", "image_name": "ghcr.io/example/psi", "image_tag": "v1",
        "job_template": {"task_alias": "psi-task"},
    }}))
    db = Database(tmp_path / "portal.sqlite")
    assert db.application_image("psi")["job_template"]["task_alias"] == "psi-task"
    (tmp_path / "appimages.json").write_text("{}")
    assert Database(tmp_path / "portal.sqlite").application_image("psi") is not None


def test_orphaned_connector_scope_can_be_reassigned_transactionally(tmp_path: Path):
    db = Database(tmp_path / "portal.sqlite")
    source = {"id": "ds-1", "connector_id": "old", "name": "source"}
    resource = {
        "id": "resource-1", "connector_id": "old", "status": "registered",
        "created_at": "before", "updated_at": "after",
    }
    db.connection().execute(
        "INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-1", "old", json.dumps(source), "before"),
    )
    db.save_resource(resource)
    db.durable_write("transfer", "task-1", {"id": "task-1", "connector_id": "old"}, "succeeded")

    db.reassign_connector("old", "new")

    assert db.datasource("ds-1", "new")["connector_id"] == "new"
    assert db.resource("resource-1", "new")["connector_id"] == "new"
    assert db.durable_read("transfer", "task-1")["connector_id"] == "new"
    assert db.datasources("old") == []
    assert db.resources("old") == []
