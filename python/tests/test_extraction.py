from types import SimpleNamespace

from bonfire_portal.application.extraction import _ftp_columns, _staging_backend


def test_staging_backend_uses_engine_default_for_legacy_profiles():
    settings = SimpleNamespace(engine_upload_backend="directory")
    assert _staging_backend({}, settings) == "directory"
    assert _staging_backend({"staging_backend": "s3"}, settings) == "s3"


def test_ftp_columns_drop_platform_only_metadata():
    assert _ftp_columns([{"name": "id", "type": "string", "comment": "业务主键", "security_level": "general_1"}]) == [
        {"name": "id", "type": "string"}
    ]


def test_ftp_columns_map_standard_types_to_kuscia_vocabulary():
    assert _ftp_columns([
        {"name": "counter", "type": "bigint"},
        {"name": "amount", "type": "decimal(10,2)"},
        {"name": "enabled", "type": "boolean"},
    ]) == [
        {"name": "counter", "type": "integer"},
        {"name": "amount", "type": "double"},
        {"name": "enabled", "type": "boolean"},
    ]
