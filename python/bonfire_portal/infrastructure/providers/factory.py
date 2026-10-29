from __future__ import annotations

from pathlib import Path
from typing import Any

from ...config import Settings
from ...domain.errors import DomainError
from .ftp import FtpProvider
from .local import LocalProvider
from .s3 import S3Provider
from .sftp import SftpProvider
from .sql import SqlProvider


def provider_for(source: dict[str, Any], settings: Settings):
    kind = source.get("type")
    # LocalFS belongs to the Portal's controlled filesystem. SeaTunnel has a
    # separate source mount, but catalog discovery must not depend on it being
    # mounted into the Portal container.
    if kind == "localfs": return LocalProvider(source, Path(settings.storage_root))
    if kind == "oss": return S3Provider(source, settings.catalog_max_sample_bytes, settings.catalog_excel_max_bytes)
    if kind == "ftp": return FtpProvider(source, settings.catalog_max_sample_bytes, settings.catalog_excel_max_bytes)
    if kind == "sftp": return SftpProvider(source, settings.catalog_max_sample_bytes, settings.catalog_excel_max_bytes)
    if kind == "jdbc": return SqlProvider(source)
    raise DomainError(422, f"暂不支持发现 {kind} 数据源")
