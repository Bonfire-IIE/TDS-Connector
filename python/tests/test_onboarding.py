from pathlib import Path

import httpx
import pytest
import respx
from cryptography import x509

from bonfire_portal.config import Settings
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.application.onboarding import OnboardingService
from bonfire_portal.infrastructure.state import PortalState


@pytest.mark.asyncio
@respx.mock
async def test_registration_generates_local_key_and_sends_only_csr(tmp_path: Path):
    settings = Settings(platform_api_base="http://center.test/api/v1", portal_data_dir=tmp_path, storage_root=tmp_path)
    database = Database(tmp_path / "portal.sqlite")
    state = PortalState(database)
    me = respx.get("http://center.test/api/v1/identity/me").mock(
        return_value=httpx.Response(200, json={"code": 0, "data": {"username": "alice"}})
    )
    registration = respx.post("http://center.test/api/v1/connectors").mock(
        return_value=httpx.Response(201, json={"code": 0, "data": {"id": "connector-a", "status": "pending"}})
    )
    service = OnboardingService(settings, database, state, lambda endpoint, port: endpoint)

    result = await service.register({"name": "ICBC", "org_name": "ICBC"}, "Bearer token")

    assert result["id"] == "connector-a"
    assert me.called and registration.called
    payload = registration.calls[0].request.content.decode()
    assert "csr_pem" in payload
    assert "PRIVATE KEY" not in payload
    pending = state.pending("alice")
    identity = Path(pending["identity_dir"])
    key_file = identity / "connector-key.pem"
    assert key_file.is_file() and key_file.stat().st_mode & 0o077 == 0
    x509.load_pem_x509_csr((identity / "connector.csr.pem").read_bytes())
