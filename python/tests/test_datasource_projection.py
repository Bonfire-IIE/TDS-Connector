from bonfire_portal.application.datasource import DataSourceApplicationService
from bonfire_portal.config import Settings
from bonfire_portal.infrastructure.database import Database


def test_datasource_registration_is_connector_local(tmp_path):
    settings = Settings(portal_data_dir=tmp_path, storage_root=tmp_path)
    database = Database(tmp_path / "portal.sqlite")
    service = DataSourceApplicationService(database, settings)

    created = service.register(
        {"name": "files", "type": "localfs", "uri": str(tmp_path), "info": {"path": str(tmp_path)}},
        "connector-a", lambda value: value,
    )

    stored = database.datasource(created["id"], "connector-a")
    assert stored == created
    assert "platform_id" not in created
    assert database.datasource(created["id"], "connector-b") is None


def test_oss_registration_allows_bucket_root_without_prefix(tmp_path):
    settings = Settings(portal_data_dir=tmp_path, storage_root=tmp_path)
    database = Database(tmp_path / "portal.sqlite")
    service = DataSourceApplicationService(database, settings)

    created = service.register(
        {"name": "bucket-root", "type": "oss", "info": {
            "endpoint": "http://minio.example:9000", "bucket": "business-data", "prefix": "",
            "access_key_id": "access", "access_key_secret": "secret",
        }},
        "connector-a", lambda value: value,
    )

    assert created["uri"] == "http://minio.example:9000/business-data"
    assert created["info"]["prefix"] == ""


def test_jdbc_registration_discards_fixed_query(tmp_path):
    settings = Settings(portal_data_dir=tmp_path, storage_root=tmp_path)
    database = Database(tmp_path / "portal.sqlite")
    service = DataSourceApplicationService(database, settings)

    created = service.register(
        {"name": "orders", "type": "jdbc", "info": {
            "seatunnel_plugin": "Jdbc",
            "options": {
                "url": "jdbc:postgresql://db:5432/business",
                "driver": "org.postgresql.Driver",
                "user": "reader",
                "password": "secret",
                "query": "DELETE FROM orders",
            },
        }},
        "connector-a", lambda value: value,
    )

    assert "query" not in created["info"]["options"]
