from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", case_sensitive=False)

    service_identities_file: str = ""
    di_url: str = ""
    dr_url: str = ""
    ts_url: str = ""
    compute_target_binding: str = "kuscia"
    port: int = 8100
    portal_data_dir: Path = Path("/state")
    storage_root: Path = Path("/data")
    web_dist: Path = Path("/app/web/dist")
    platform_api_base: str = "http://127.0.0.1:8000/api/v1"
    portal_container_host: str = ""
    seatunnel_api_base: str = "http://127.0.0.1:5801"
    seatunnel_source_root: Path = Path("/connectors/source")
    seatunnel_staging_root: Path = Path("/var/lib/bonfire/staging")
    seatunnel_job_timeout_ms: int = 180_000
    require_https: bool = False
    trust_proxy: bool = False
    execution_auth_mode: str = "signature"
    execution_dispatch_secret: str = Field(default="", repr=False)
    engine_upload_host: str = ""
    engine_upload_port: int = 2121
    engine_upload_backend: str = "directory"

    catalog_page_size: int = 100
    catalog_max_page_size: int = 500
    catalog_sample_rows: int = 20
    catalog_max_sample_rows: int = 200
    catalog_max_sample_bytes: int = 8 * 1024 * 1024
    catalog_excel_max_bytes: int = 64 * 1024 * 1024
    catalog_timeout_seconds: float = 15.0
    catalog_index_interval_seconds: int = 3600
    catalog_index_batch_size: int = 500
    catalog_worker_threads: int = 4
    catalog_cursor_secret: str = Field(default="", repr=False)

    @property
    def sqlite_path(self) -> Path:
        return self.portal_data_dir / "portal-services.sqlite"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.portal_data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    return settings
