from pathlib import Path

import httpx
import pytest
import respx

import bonfire_portal.infrastructure.platform as platform_client_module
from bonfire_portal.config import Settings
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.platform import PlatformClient


def settings(tmp_path: Path) -> Settings:
    return Settings(
        platform_api_base="http://center.test/api/v1",
        portal_data_dir=tmp_path,
        storage_root=tmp_path,
    )


@pytest.mark.asyncio
@respx.mock
async def test_platform_client_unwraps_center_envelope_and_forwards_bearer(tmp_path: Path):
    route = respx.get("http://center.test/api/v1/connectors").mock(
        return_value=httpx.Response(200, json={"code": 0, "message": "ok", "data": [{"id": "c1"}]})
    )

    result = await PlatformClient(settings(tmp_path), "token").list_connectors()

    assert result == [{"id": "c1"}]
    assert route.called
    assert route.calls[0].request.headers["authorization"] == "Bearer token"


@pytest.mark.asyncio
@respx.mock
async def test_platform_client_preserves_center_error_message(tmp_path: Path):
    respx.get("http://center.test/api/v1/identity/me").mock(
        return_value=httpx.Response(403, json={"code": 403, "message": "连接器未审批通过"})
    )

    with pytest.raises(DomainError, match="连接器未审批通过") as exc:
        await PlatformClient(settings(tmp_path), "token").me()
    assert exc.value.status_code == 403


@pytest.mark.asyncio
@respx.mock
async def test_machine_gateway_request_uses_expected_identity_path(tmp_path: Path):
    route = respx.get(
        "http://center.test/api/v1/privacy-computing/gateway/runs/run-1/identity",
        params={"connector_id": "sender", "peer_connector_id": "receiver"},
    ).mock(return_value=httpx.Response(200, json={"code": 0, "data": {"certificate_pem": "pem"}}))

    profile = {"connector_id": "sender", "identity_dir": str(tmp_path / "missing")}
    client = PlatformClient(settings(tmp_path), None)
    # Signature authentication needs a real key; shared-secret mode isolates
    # this contract test from certificate material and tests the HTTP boundary.
    client.settings.execution_auth_mode = "shared-secret"
    client.settings.execution_dispatch_secret = "x" * 32

    result = await client.machine_execution_identity("run-1", profile, "receiver")

    assert result["certificate_pem"] == "pem"
    assert route.called


@pytest.mark.asyncio
@respx.mock
async def test_machine_gateway_signature_target_includes_api_prefix(tmp_path: Path, monkeypatch):
    route = respx.get(
        "http://center.test/api/v1/privacy-computing/gateway/runs/run-1/identity",
        params={"connector_id": "sender", "peer_connector_id": "receiver"},
    ).mock(return_value=httpx.Response(200, json={"code": 0, "data": {"certificate_pem": "pem"}}))
    captured = {}

    def capture_headers(profile, recipient, method, target, body, settings):
        captured["target"] = target
        return {}

    monkeypatch.setattr(platform_client_module, "execution_headers", capture_headers)
    client = PlatformClient(settings(tmp_path), None)

    await client.machine_execution_identity("run-1", {"connector_id": "sender"}, "receiver")

    assert route.called
    assert captured["target"] == (
        "/api/v1/privacy-computing/gateway/runs/run-1/identity"
        "?connector_id=sender&peer_connector_id=receiver"
    )


@pytest.mark.asyncio
@respx.mock
async def test_project_paths_match_center_contract(tmp_path: Path):
    projects = respx.get(
        "http://center.test/api/v1/projects", params={"connector_id": "c1"}
    ).mock(return_value=httpx.Response(200, json={"code": 0, "data": []}))
    project = respx.get("http://center.test/api/v1/projects/p1").mock(
        return_value=httpx.Response(200, json={"code": 0, "data": {"id": "p1"}})
    )
    client = PlatformClient(settings(tmp_path), "token")

    assert await client.list_projects("c1") == []
    assert (await client.get_project("p1"))["id"] == "p1"
    assert projects.called and project.called
