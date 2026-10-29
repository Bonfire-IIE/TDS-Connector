import pytest
from pathlib import Path
import json

from bonfire_portal.infrastructure.kuscia import KusciaError, LiteClient


@pytest.mark.asyncio
async def test_kuscia_domain_data_payload_matches_api_contract():
    client = object.__new__(LiteClient)
    calls = []
    async def request(method, path, payload=None, timeout=None, params=None):
        calls.append((method, path, payload)); return {"status": {"code": 0}}
    client.request = request
    await client.create_domain_data(domain_id="alice", data_id="data-1", name="input", relative_uri="staging/data.csv",
                                    columns=[{"name": "id", "type": "string"}], datasource_id="storage")
    payload = calls[0][2]
    assert "data" not in payload
    assert payload["columns"][0]["type"] == "str"
    assert payload["vendor"] == "bonfire"


@pytest.mark.asyncio
async def test_kuscia_job_and_grant_payloads_are_not_wrapped():
    client = object.__new__(LiteClient)
    calls = []
    async def request(method, path, payload=None, timeout=None, params=None):
        calls.append((path, payload)); return {"status": {"code": 0}}
    client.request = request
    await client.create_domain_data_grant("alice", "data-1", "bob")
    await client.create_job({"job_id": "job-1", "tasks": []})
    assert calls[0][1] == {"domain_id": "alice", "domaindata_id": "data-1", "grant_domain": "bob"}
    assert calls[1][1] == {"job_id": "job-1", "tasks": []}


@pytest.mark.asyncio
async def test_kuscia_route_query_and_delete_match_api_contract():
    client = object.__new__(LiteClient)
    calls = []
    async def request(method, path, payload=None, timeout=None, params=None):
        calls.append((path, payload)); return {"status": {"code": 0}, "data": {"status": {"status": "Ready"}}}
    client.request = request
    route = await client.query_route("alice", "bob")
    await client.delete_route("alice", "bob")
    assert route == {"status": {"status": "Ready"}}
    assert calls == [
        ("/api/v1/route/query", {"source": "alice", "destination": "bob"}),
        ("/api/v1/route/delete", {"source": "alice", "destination": "bob"}),
    ]


@pytest.mark.asyncio
async def test_create_route_keeps_matching_endpoint_and_replaces_stale_endpoint():
    client = object.__new__(LiteClient)
    calls = []
    current = {"endpoint": {"host": "peer.example", "ports": [{"port": 38080, "isTLS": True}]}}

    async def request(method, path, payload=None, timeout=None, params=None):
        nonlocal current
        calls.append((method, path, payload))
        if path == "/api/v1/route/query":
            return {"data": current}
        if path == "/api/v1/route/delete":
            current = None
        return {"status": {"code": 0}}

    client.request = request
    await client.create_route("alice", "bob", "peer.example", 38080, True)
    assert [path for _, path, _ in calls] == ["/api/v1/route/query"]

    calls.clear()
    current = {"endpoint": {"host": "stale.example", "ports": [{"port": 1080, "isTLS": False}]}}
    await client.create_route("alice", "bob", "peer.example", 38080, True)
    assert [path for _, path, _ in calls] == [
        "/api/v1/route/query", "/api/v1/route/delete", "/api/v1/route/create",
    ]


@pytest.mark.asyncio
async def test_partner_domain_certificate_rotation_requires_explicit_trust():
    client = object.__new__(LiteClient)
    calls = []

    async def request(method, path, payload=None, timeout=None, params=None):
        calls.append((method, path, payload))
        if path == "/api/v1/domain/create":
            raise KusciaError("domain already exists")
        if path == "/api/v1/domain/query":
            return {"data": {"cert": "old-cert", "auth_center": None, "master_domain_id": ""}}
        return {"status": {"code": 0}}

    client.request = request
    with pytest.raises(KusciaError, match="显式更新"):
        await client.ensure_partner_domain("bob", "new-cert")
    await client.ensure_partner_domain("bob", "new-cert", allow_certificate_update=True)
    assert calls[-1] == ("POST", "/api/v1/domain/update", {
        "domain_id": "bob", "role": "partner", "cert": "new-cert",
        "auth_center": None, "master_domain_id": "",
    })


@pytest.mark.asyncio
async def test_kuscia_file_api_uses_bundle_routes():
    client = object.__new__(LiteClient)
    calls = []

    async def request(method, path, payload=None, timeout=None, params=None):
        calls.append((method, path, payload, params))
        return {"status": {"code": 0}, "files": []}

    client.request = request
    await client.file_health()
    await client.list_files("staging")
    await client.mkdir_file("staging/out")
    await client.delete_file("staging/out", True)
    await client.rename_file("staging/a", "staging/b")
    assert [(method, path) for method, path, _, _ in calls] == [
        ("GET", "/api/v1/file/healthz"),
        ("GET", "/api/v1/file/list"),
        ("POST", "/api/v1/file/mkdir"),
        ("POST", "/api/v1/file/delete"),
        ("POST", "/api/v1/file/rename"),
    ]


@pytest.mark.asyncio
async def test_legacy_file_service_context_uses_serving_gateway():
    client = object.__new__(LiteClient)
    client.endpoint = "https://localhost:28081"
    client.cert_dir = Path("/tmp/lite/icbc-pk-kuscia/certs")

    async def request(method, path, payload=None, timeout=None, params=None):
        assert (method, path) == ("POST", "/api/v1/serving/query")
        return {"data": {
            "serving_input_config": json.dumps({"token": "file-token"}),
            "parties": [{"service_name_prefix": "filesvc-icbc-pk-kuscia"}],
            "status": {"party_statuses": [{"endpoints": [{
                "port_name": "http",
                "endpoint": "filesvc-icbc-pk-kuscia-http.icbc-pk-kuscia.svc:21209",
            }]}]},
        }}

    client.request = request
    gateway, host, source, token = await client._legacy_file_context()
    assert gateway == "http://localhost:28083"
    assert host == "filesvc-icbc-pk-kuscia-http.icbc-pk-kuscia.svc"
    assert source == "icbc-pk-kuscia"
    assert token == "file-token"
