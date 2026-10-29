from pathlib import Path

import pytest

from bonfire_portal.application.node_operations import NodeOperationsService
from bonfire_portal.config import Settings
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.infrastructure.state import PortalState


def service(tmp_path: Path) -> NodeOperationsService:
    database = Database(tmp_path / "portal.sqlite")
    return NodeOperationsService(
        Settings(portal_data_dir=tmp_path, storage_root=tmp_path),
        PortalState(database),
    )


@pytest.mark.asyncio
async def test_file_status_is_unavailable_without_kuscia(tmp_path: Path):
    result = await service(tmp_path).status("connector-a")
    assert result["available"] is False
    assert result["backend"] == "kuscia"


@pytest.mark.asyncio
async def test_files_and_logs_require_kuscia_plugin(tmp_path: Path):
    operations = service(tmp_path)
    with pytest.raises(DomainError, match="隐私计算引擎尚未配置"):
        await operations.files("connector-a", "")
    with pytest.raises(DomainError, match="隐私计算引擎尚未配置"):
        await operations.log_files("connector-a", None)
