from pathlib import Path

import pytest

from bonfire_portal.application.execution_gateway import (
    ExecutionGatewayContext,
    ExecutionGatewayService,
)
from bonfire_portal.config import Settings
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.infrastructure.state import PortalState


@pytest.mark.asyncio
async def test_machine_report_uses_signed_platform_request(tmp_path: Path, monkeypatch):
    database = Database(tmp_path / "portal.sqlite")
    state = PortalState(database)
    state.save_profile("connector-a", {
        "connector_id": "connector-a",
        "identity_dir": str(tmp_path / "identity"),
    })
    service = ExecutionGatewayService(
        Settings(platform_api_base="http://center.test/api/v1", portal_data_dir=tmp_path,
                 storage_root=tmp_path),
        database, state, executions=None,
    )
    calls = []

    class FakePlatform:
        def __init__(self, settings, authorization):
            assert authorization is None

        async def machine_report_execution(self, run_id, profile, payload):
            calls.append((run_id, profile, payload))
            return {"accepted": True}

    monkeypatch.setattr(
        "bonfire_portal.application.execution_gateway.PlatformClient", FakePlatform
    )
    result = await service.report(
        ExecutionGatewayContext("connector-a", machine_dispatch=True, machine_signer="@center"),
        "run-1", {"status": "running"},
    )

    assert result == {"accepted": True}
    assert calls[0][0] == "run-1"
    assert calls[0][2] == {"connector_id": "connector-a", "status": "running"}
