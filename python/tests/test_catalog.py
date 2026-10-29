from pathlib import Path

import json
import pytest

from bonfire_portal.application.catalog import CatalogService
from bonfire_portal.config import Settings
from bonfire_portal.domain.catalog import ColumnSchema, DataObject, InspectionResult
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.infrastructure.inspection import inspect_path
from bonfire_portal.infrastructure.object_refs import decode_ref, encode_ref
from bonfire_portal.interfaces.http.catalog import CatalogHttpAdapter


def test_object_ref_is_stable_and_opaque():
    value = encode_ref("localfs", {"kind": "file", "path": "a/data.csv"})
    assert value.startswith("obj1.")
    assert decode_ref(value, "localfs")["path"] == "a/data.csv"


def test_csv_inspection(tmp_path: Path):
    path = tmp_path / "data.csv"
    path.write_text("id,name\n1,A\n2,B\n", encoding="utf-8")
    result = inspect_path(path, "obj1.test", 10)
    assert [column.name for column in result.columns] == ["id", "name"]
    assert result.columns[0].type in {"bigint", "int"}
    assert result.sampled_rows == 2


def test_tsv_inspection_preserves_tsv_format(tmp_path: Path):
    path = tmp_path / "data.tsv"
    path.write_text("id\tamount\n1\t2.5\n", encoding="utf-8")

    result = inspect_path(path, "obj1.test", 10)

    assert result.format == "tsv"
    assert [column.name for column in result.columns] == ["id", "amount"]


def test_csv_inspection_supports_gb18030_without_modifying_source(tmp_path: Path):
    path = tmp_path / "fingerprint.csv"
    original = "fingerprint\r\n18843224456\r\n张三\r\nbm\r\n42\r\n".encode("gb18030")
    path.write_bytes(original)

    result = inspect_path(path, "obj1.test", 20)

    assert [column.name for column in result.columns] == ["fingerprint"]
    assert [row[0] for row in result.sample] == ["18843224456", "张三", "bm", "42"]
    assert result.warnings == ["检测到源文件编码为 gb18030，结构探测时已临时转换为 UTF-8"]
    assert path.read_bytes() == original


def test_localfs_catalog_uses_portal_storage_root(tmp_path: Path):
    root = tmp_path / "portal-storage"
    root.mkdir()
    (root / "data.csv").write_text("id\n1\n", encoding="utf-8")
    db = Database(tmp_path / "portal.sqlite")
    source = {"id": "ds-local", "connector_id": "connector-a", "type": "localfs", "name": "local",
              "uri": "/data", "info": {"path": "/data"}}
    db.connection().execute("INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-local", "connector-a", json.dumps(source), "now"))
    service = CatalogService(db, Settings(portal_data_dir=tmp_path, storage_root=root))
    assert [item.name for item in service.objects("ds-local", "connector-a", None, None, 20).items] == ["data.csv"]


def test_localfs_catalog_hides_portal_state(tmp_path: Path):
    root = tmp_path / "portal-storage"
    root.mkdir()
    (root / "data.csv").write_text("id\n1\n", encoding="utf-8")
    (root / "portal.sqlite").write_text("private", encoding="utf-8")
    (root / "identity").mkdir()
    db = Database(tmp_path / "portal.sqlite")
    source = {"id": "ds-local", "connector_id": "connector-a", "type": "localfs", "name": "local",
              "uri": "/data", "info": {"path": "/data"}}
    db.connection().execute("INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-local", "connector-a", json.dumps(source), "now"))
    service = CatalogService(db, Settings(portal_data_dir=tmp_path, storage_root=root))
    assert [item.name for item in service.objects("ds-local", "connector-a", None, None, 20).items] == ["data.csv"]


def test_catalog_source_is_connector_scoped_and_fts_search_works(tmp_path: Path):
    db = Database(tmp_path / "portal.sqlite")
    source = {"id": "ds-a", "connector_id": "connector-a", "type": "localfs", "name": "A",
              "uri": str(tmp_path), "info": {"path": str(tmp_path)}}
    db.connection().execute("INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-a", "connector-a", json.dumps(source), "now"))
    service = CatalogService(db, Settings(portal_data_dir=tmp_path))
    with pytest.raises(DomainError, match="不属于"):
        service.source("ds-a", "connector-b")
    service._save_object("ds-a", DataObject("obj1.test", "file", "customers.csv", "incoming/customers.csv",
        None, True, False, "structured", "csv", inspectable=True, transferable=True), 1)
    page = service.objects("ds-a", "connector-a", None, None, 20, "customer")
    assert [item.name for item in page.items] == ["customers.csv"]
    with pytest.raises(DomainError, match="不属于"):
        service.objects("ds-a", "connector-b", None, None, 20, "customer")


def test_catalog_fts_search_is_paginated(tmp_path: Path):
    db = Database(tmp_path / "portal.sqlite")
    source = {"id": "ds-a", "connector_id": "connector-a", "type": "localfs", "name": "A",
              "uri": str(tmp_path), "info": {"path": str(tmp_path)}}
    db.connection().execute("INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-a", "connector-a", json.dumps(source), "now"))
    service = CatalogService(db, Settings(portal_data_dir=tmp_path))
    for index in range(3):
        service._save_object("ds-a", DataObject(f"obj1.{index}", "file", f"customer-{index}.csv",
            f"incoming/customer-{index}.csv", None, True, False, "structured", "csv", inspectable=True), 1)
    first = service.objects("ds-a", "connector-a", None, None, 2, "customer")
    second = service.objects("ds-a", "connector-a", None, first.next_cursor, 2, "customer")
    assert first.truncated is True
    assert first.next_cursor == "2"
    assert len(first.items) == 2
    assert [item.name for item in second.items] == ["customer-2.csv"]
    assert second.next_cursor is None


@pytest.mark.asyncio
async def test_compatibility_capability_files_and_scan_projection(tmp_path: Path):
    root = tmp_path / "portal-storage"
    root.mkdir()
    (root / "data.tsv").write_text("id\tactive\n1\ttrue\n2\tfalse\n", encoding="utf-8")
    database = Database(tmp_path / "portal.sqlite")
    source = {"id": "ds-local", "connector_id": "connector-a", "type": "localfs", "name": "local",
              "uri": "/data", "info": {"path": "/data"}}
    database.connection().execute(
        "INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-local", "connector-a", json.dumps(source), "now"),
    )
    settings = Settings(portal_data_dir=tmp_path, storage_root=root)
    adapter = CatalogHttpAdapter(CatalogService(database, settings), settings)

    capability = await adapter.capability("ds-local", "connector-a")
    files = await adapter.files("ds-local", "connector-a", "")
    scanned = await adapter.scan(
        "ds-local", "connector-a", files["entries"][0]["object_ref"], 20
    )

    assert capability["listing"] is True
    assert capability["scanning"] is True
    assert files["entries"][0]["format"] == "tsv"
    assert files["entries"][0]["transferable"] is True
    assert scanned["format"] == "tsv"
    assert scanned["columns"][0]["kind"] == "integer"
    assert scanned["columns"][0]["min"] == 1
    assert scanned["columns"][0]["max"] == 2


@pytest.mark.asyncio
async def test_compatibility_files_resolves_nested_directory_paths(tmp_path: Path):
    root = tmp_path / "portal-storage"
    nested = root / "in" / "archive"
    nested.mkdir(parents=True)
    (nested / "data.csv").write_text("id\n001\n", encoding="utf-8")
    database = Database(tmp_path / "portal.sqlite")
    source = {"id": "ds-local", "connector_id": "connector-a", "type": "localfs", "name": "local",
              "uri": "/data", "info": {"path": "/data"}}
    database.connection().execute(
        "INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-local", "connector-a", json.dumps(source), "now"),
    )
    settings = Settings(portal_data_dir=tmp_path, storage_root=root)
    adapter = CatalogHttpAdapter(CatalogService(database, settings), settings)

    first = await adapter.files("ds-local", "connector-a", "in")
    second = await adapter.files("ds-local", "connector-a", "in/archive")
    scanned = await adapter.scan("ds-local", "connector-a", "in/archive/data.csv", 20)

    assert [(item["path"], item["kind"]) for item in first["entries"]] == [("in/archive", "directory")]
    assert [(item["path"], item["kind"]) for item in second["entries"]] == [("in/archive/data.csv", "file")]
    assert [column["name"] for column in scanned["columns"]] == ["id"]
    assert database.connection().execute(
        "SELECT count(*) FROM catalog_object WHERE datasource_id=?", ("ds-local",)
    ).fetchone()[0] == 0


@pytest.mark.asyncio
async def test_database_api_lists_schemas_and_relations_without_file_compatibility(tmp_path: Path):
    database = Database(tmp_path / "portal.sqlite")
    source = {"id": "ds-jdbc", "connector_id": "connector-a", "type": "jdbc", "name": "orders-db",
              "uri": "jdbc:postgresql://database/orders", "info": {"options": {}}}
    database.connection().execute(
        "INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds-jdbc", "connector-a", json.dumps(source), "now"),
    )
    settings = Settings(portal_data_dir=tmp_path)
    service = CatalogService(database, settings)
    schema_ref = encode_ref("jdbc", {"kind": "schema", "schema": "public"})
    table_ref = encode_ref("jdbc", {"kind": "table", "schema": "public", "name": "orders"})

    class FakeJdbcProvider:
        def list_objects(self, parent_ref, cursor, limit):
            if parent_ref is None:
                return type("Page", (), {"items": [
                    DataObject(schema_ref, "schema", "public", "public", None, False, True)
                ], "next_cursor": None, "truncated": False})()
            assert parent_ref == schema_ref
            return type("Page", (), {"items": [
                DataObject(table_ref, "table", "orders", "public.orders", schema_ref,
                           True, False, "structured", "table", inspectable=True, transferable=True)
            ], "next_cursor": None, "truncated": False})()

        def walk(self):
            yield DataObject(schema_ref, "schema", "public", "public", None, False, True)
            yield DataObject(table_ref, "table", "orders", "public.orders", schema_ref,
                             True, False, "structured", "table", inspectable=True, transferable=True)

        def inspect(self, object_ref, sample_rows, options):
            assert object_ref == table_ref
            return InspectionResult(table_ref, "structured", "table", "declared", [
                ColumnSchema("id", "bigint", "BIGINT", False, 1.0)
            ], 2, True, [[1], [2]], "sha256:test")

        def close(self):
            pass

    service.provider = lambda datasource_id, connector_id: FakeJdbcProvider()
    adapter = CatalogHttpAdapter(service, settings)

    schemas = await adapter.database_schemas("ds-jdbc", "connector-a", None)
    relations = await adapter.database_relations("ds-jdbc", "connector-a", schema_ref, None)
    inspected = await adapter.database_inspect("ds-jdbc", "connector-a", table_ref, 20)

    assert schemas["items"] == [{"name": "public", "object_ref": schema_ref}]
    assert [(item["qualified_name"], item["relation_type"]) for item in relations["items"]] == [
        ("public.orders", "table")
    ]
    assert [(column["name"], column["kind"]) for column in inspected["columns"]] == [("id", "integer")]
    with pytest.raises(DomainError, match="Schema 与表"):
        await adapter.files("ds-jdbc", "connector-a", "")
