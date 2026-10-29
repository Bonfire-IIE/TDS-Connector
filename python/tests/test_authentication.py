from pathlib import Path
import httpx
import pytest
import respx

from bonfire_portal.application.authentication import AuthenticationRequest, PortalAuthenticator
from bonfire_portal.config import Settings
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.infrastructure.state import PortalState


def request(path: str, connector_id: str = "", headers: dict[str, str] | None = None) -> AuthenticationRequest:
    return AuthenticationRequest(path=path, method="POST", query="", headers=headers or {},
                                 body=b"", configured_connector_id=connector_id)


@pytest.mark.asyncio
@respx.mock
async def test_browser_identity_is_bound_to_owned_selected_connector(tmp_path: Path):
    settings = Settings(platform_api_base="http://center.test/api/v1", portal_data_dir=tmp_path, storage_root=tmp_path)
    database = Database(tmp_path / "portal.sqlite")
    state = PortalState(database)
    state.save_profile("alice", {"connector_id": "connector-a"})
    respx.get("http://center.test/api/v1/identity/me").mock(
        return_value=httpx.Response(200, json={"code": 0, "data": {"username": "alice"}})
    )
    respx.get("http://center.test/api/v1/connectors").mock(
        return_value=httpx.Response(200, json={"code": 0, "data": [{"id": "connector-a"}]})
    )
    incoming = request("/portal/resources", headers={"authorization": "Bearer token"})

    result = await PortalAuthenticator(settings, database, state).authenticate(incoming)

    assert result.connector_id == "connector-a"


@pytest.mark.asyncio
async def test_machine_shared_secret_binds_recipient_and_rejects_wrong_secret(tmp_path: Path):
    settings = Settings(
        portal_data_dir=tmp_path, storage_root=tmp_path,
        execution_auth_mode="shared-secret", execution_dispatch_secret="s" * 32,
    )
    database = Database(tmp_path / "portal.sqlite")
    state = PortalState(database)
    for action in ("identity", "prepare", "execute", "sync", "report", "artifacts"):
        path = f"/portal/integrations/privacy-compute/execution-requests/run-1/{action}"
        valid = request(path, "connector-b", {"x-bonfire-execution-secret": "s" * 32})

        result = await PortalAuthenticator(settings, database, state).authenticate(valid)

        assert result.connector_id == "connector-b"
        assert result.machine_dispatch is True
        invalid = request(path, "connector-b", {"x-bonfire-execution-secret": "x" * 32})
        with pytest.raises(DomainError, match="Authorization"):
            await PortalAuthenticator(settings, database, state).authenticate(invalid)
