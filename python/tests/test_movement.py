from pathlib import Path

import pytest

from bonfire_portal.config import Settings
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.application.movement import (
    MovementService, compile_binary_file_transfer, compile_database_transfer,
    compile_structured_file_transfer, compile_transfer,
)
from bonfire_portal.domain.movement import BinaryFileTransferPlan


def _source():
    return {"id": "ds", "connector_id": "c", "type": "localfs", "uri": "/data",
            "info": {"path": "/data", "options": {}}}


def test_transfer_compiles_local_csv_without_credentials(tmp_path: Path):
    settings = Settings(seatunnel_source_root=tmp_path / "source", seatunnel_staging_root=tmp_path / "stage")
    value = compile_transfer({"input": {"datasource_id": "ds", "files": ["data.csv"]},
        "output": {"target": "staging-dir", "path": "run-1"},
        "columns": [{"name": "id", "type": "string"}]}, _source(), settings)
    assert value["source"][0]["plugin_name"] == "LocalFile"
    assert value["sink"][0]["path"].endswith("/stage/run-1")


def test_transfer_compiles_selected_columns_and_conditions(tmp_path: Path):
    settings = Settings(seatunnel_source_root=tmp_path / "source", seatunnel_staging_root=tmp_path / "stage")
    value = compile_transfer({"input": {"datasource_id": "ds", "files": ["data.csv"]},
        "output": {"target": "staging-dir"}, "columns": [{"name": "id", "type": "string"}, {"name": "age", "type": "integer"}],
        "filter": {"fields": ["id"], "conditions": [{"field": "age", "kind": "integer", "op": "gte", "value": 18}]}},
        _source(), settings)
    assert value["transform"][0]["query"] == "select id from bonfire_source where age >= 18"
    assert value["sink"][0]["sink_columns"] == ["id"]


def test_transfer_uses_the_shared_standard_type_mapping(tmp_path: Path):
    settings = Settings(seatunnel_source_root=tmp_path / "source", seatunnel_staging_root=tmp_path / "stage")
    value = compile_transfer({"input": {"datasource_id": "ds", "files": ["data.csv"]},
        "output": {"target": "staging-dir"}, "columns": [
            {"name": "counter", "type": "integer"}, {"name": "amount", "type": "decimal(10,2)"},
        ]}, _source(), settings)
    assert value["source"][0]["schema"]["fields"] == {
        "counter": "int", "amount": "decimal(10,2)",
    }


def test_transfer_compiles_s3_path_style_properties(tmp_path: Path):
    source = {"id": "oss", "connector_id": "c", "type": "oss", "info": {"endpoint": "http://minio:9000",
        "bucket": "data", "prefix": "incoming", "access_key_id": "ak", "access_key_secret": "sk", "virtualhost": False}}
    value = compile_transfer({"input": {"datasource_id": "oss", "files": ["data.csv"]},
        "output": {"target": "staging-dir"}, "columns": [{"name": "id", "type": "string"}]}, source,
        Settings(seatunnel_staging_root=tmp_path / "stage"))
    config = value["source"][0]
    assert config["path"] == "/incoming/data.csv"
    assert config["hadoop_s3_properties"]["fs.s3a.path.style.access"] == "true"


def test_jdbc_transfer_uses_selected_table_not_datasource_query(tmp_path: Path):
    source = {"id": "jdbc", "connector_id": "c", "type": "jdbc", "info": {
        "seatunnel_plugin": "Jdbc", "options": {
            "url": "jdbc:postgresql://db:5432/business",
            "driver": "org.postgresql.Driver",
            "user": "reader", "password": "secret",
            "query": "DELETE FROM customers",
        },
    }}

    value = compile_transfer({
        "input": {"datasource_id": "jdbc", "files": ["public.orders"]},
        "output": {"target": "staging-dir", "format": "csv"},
        "columns": [{"name": "id", "type": "bigint"}],
    }, source, Settings(seatunnel_staging_root=tmp_path / "stage"))

    assert value["source"][0]["query"] == 'SELECT * FROM "public"."orders"'


def test_typed_database_transfer_has_relation_not_files(tmp_path: Path):
    source = {"id": "jdbc", "connector_id": "c", "type": "jdbc", "info": {
        "seatunnel_plugin": "Jdbc", "options": {
            "url": "jdbc:postgresql://db:5432/business", "driver": "org.postgresql.Driver",
            "user": "reader", "password": "secret",
        },
    }}
    plan = {"plan_kind": "database", "input": {"datasource_id": "jdbc", "relation": "public.orders"},
            "output": {"target": "staging-dir", "format": "csv"},
            "columns": [{"name": "id", "type": "bigint"}], "output_format": "csv"}

    value = compile_database_transfer(plan, source, Settings(seatunnel_staging_root=tmp_path / "stage"))

    assert value["source"][0]["query"] == 'SELECT * FROM "public"."orders"'
    with pytest.raises(DomainError, match="不接受数据库"):
        compile_structured_file_transfer({**plan, "plan_kind": "structured-file"}, source,
                                         Settings(seatunnel_staging_root=tmp_path / "stage"))


def test_binary_file_transfer_is_schema_free_and_rejects_structured_output(tmp_path: Path):
    plan = {"plan_kind": "binary-file", "input": {"datasource_id": "ds", "files": ["archive.bin"]},
            "output": {"target": "staging-dir"}}
    validated = BinaryFileTransferPlan.model_validate(plan).model_dump(exclude_none=True)

    value = compile_binary_file_transfer(validated, _source(),
                                         Settings(seatunnel_source_root=tmp_path / "source",
                                                  seatunnel_staging_root=tmp_path / "stage"))

    assert value["source"][0]["file_format_type"] == "binary"
    assert value["sink"][0]["file_format_type"] == "binary"
    assert "schema" not in value["source"][0]
    with pytest.raises(ValueError, match="binary"):
        BinaryFileTransferPlan.model_validate({**plan, "output": {"target": "staging-dir", "format": "csv"}})


def test_internal_transfer_compiles_ftp_resource_uri_and_redacts_credentials(tmp_path: Path):
    source = {
        "id": "ftp",
        "connector_id": "c",
        "type": "ftp",
        "info": {
            "path": "/ftp/bonfire",
            "seatunnel_plugin": "FtpFile",
            "options": {
                "host": "10.26.174.75",
                "port": 2221,
                "user": "bonfire",
                "password": "secret",
            },
        },
    }
    plan = {
        "input": {"datasource_id": "ftp", "files": ["in/customers.csv"]},
        "output": {"target": "staging-dir", "path": "run-ftp"},
        "columns": [{"name": "id", "type": "string"}],
    }

    value = compile_transfer(
        plan,
        source,
        Settings(seatunnel_staging_root=tmp_path / "stage"),
    )

    config = value["source"][0]
    assert config["plugin_name"] == "FtpFile"
    assert config["path"] == "/ftp/bonfire/in/customers.csv"
    assert config["host"] == "10.26.174.75"
    assert config["port"] == 2221
    assert config["user"] == "bonfire"
    assert config["password"] == "secret"
    assert config["connection_mode"] == '"PASSIVE_LOCAL_DATA_CONNECTION_MODE"'

    db = Database(tmp_path / "portal.sqlite")
    import json
    db.connection().execute(
        "INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ftp", "c", json.dumps(source), "now"),
    )
    task = MovementService(db, Settings(seatunnel_staging_root=tmp_path / "stage")).create(
        plan, "c", "ftp-resource-extraction"
    )
    assert task["plan"]["input"]["files"] == ["in/customers.csv"]
    assert task["preview"]["source"][0]["password"] == "[REDACTED]"


def test_ftp_output_places_transaction_staging_in_remote_target(tmp_path: Path):
    output = {
        "id": "ftp-output",
        "connector_id": "c",
        "type": "ftp",
        "info": {
            "path": "/ftp/bonfire/out",
            "seatunnel_plugin": "FtpFile",
            "options": {
                "host": "10.26.174.75",
                "port": 2221,
                "user": "bonfire",
                "password": "secret",
            },
        },
    }
    plan = {
        "input": {"datasource_id": "ds", "files": ["data.csv"]},
        "output": {"target": "datasource", "datasource_id": "ftp-output", "format": "csv"},
        "columns": [{"name": "id", "type": "string"}],
    }

    value = compile_transfer(
        plan,
        _source(),
        Settings(seatunnel_source_root=tmp_path / "source"),
        output,
    )

    assert value["sink"][0]["plugin_name"] == "FtpFile"
    assert value["sink"][0]["path"] == "/ftp/bonfire/out"
    assert value["sink"][0]["is_enable_transaction"] is True
    assert value["sink"][0]["tmp_path"] == "/ftp/bonfire/out/.seatunnel-tmp"


def test_transfer_idempotency(tmp_path: Path):
    db = Database(tmp_path / "portal.sqlite")
    db.connection().execute("INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("ds", "c", '{"id":"ds","connector_id":"c","type":"localfs","uri":"/data","info":{"path":"/data"}}', "now"))
    service = MovementService(db, Settings(seatunnel_source_root=tmp_path / "source", seatunnel_staging_root=tmp_path / "stage"))
    plan = {"input": {"datasource_id": "ds", "files": ["data.csv"]}, "output": {"target": "staging-dir"}, "columns": [{"name": "id", "type": "string"}]}
    first = service.create(plan, "c", "request-1"); second = service.create(plan, "c", "request-1")
    assert first["id"] == second["id"]
    assert service.public(first)["config"] == first["preview"]
    with pytest.raises(DomainError, match="已绑定其他配置"):
        service.create({**plan, "output": {"target": "staging-dir", "path": "other"}}, "c", "request-1")


def test_transfer_preview_never_persists_credentials(tmp_path: Path):
    db = Database(tmp_path / "portal.sqlite")
    source = {"id": "oss", "connector_id": "c", "type": "oss", "uri": "connector://oss",
        "info": {"endpoint": "http://minio:9000", "bucket": "data", "access_key_id": "ak", "access_key_secret": "sk"}}
    import json
    db.connection().execute("INSERT INTO datasource(id,connector_id,payload,created_at) VALUES(?,?,?,?)",
        ("oss", "c", json.dumps(source), "now"))
    service = MovementService(db, Settings(seatunnel_staging_root=tmp_path / "stage"))
    task = service.create({"input": {"datasource_id": "oss", "files": ["data.csv"]},
        "output": {"target": "staging-dir"}, "columns": [{"name": "id", "type": "string"}]}, "c", "secret-test")
    preview_source = task["preview"]["source"][0]
    assert preview_source["access_key"] == "[REDACTED]"
    assert preview_source["secret_key"] == "[REDACTED]"
