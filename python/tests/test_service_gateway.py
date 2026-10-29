import hashlib
import hmac
import json
from pathlib import Path

import httpx
import pytest
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse
from bonfire_portal.config import Settings
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.services import ServiceGateway
from bonfire_portal.interfaces.http.services import install


@pytest.fixture
def gateway(tmp_path, monkeypatch):
    path = tmp_path / 'identities.json'
    identity = {'tenant_id': 't1', 'connector_id': 'edge', 'di': {'token_env': 'TEST_DI_TOKEN'},
                'dr': {'token_env': 'TEST_DI_TOKEN'}, 'ts': {'signer': 'alice', 'secret_env': 'TEST_TS_SECRET', 'roles': ['admin']}}
    path.write_text(json.dumps({'users': {'center-edge': {'alice': identity}}, 'machines': {'center-edge': identity}}))
    monkeypatch.setenv('TEST_DI_TOKEN', 'd'*32); monkeypatch.setenv('TEST_TS_SECRET', 's'*32)
    return ServiceGateway(Settings(service_identities_file=str(path), di_url='http://di.test', dr_url='http://dr.test', ts_url='http://ts.test'))


@pytest.mark.asyncio
async def test_scope_headers_and_ts_v2_bind_idempotency(gateway):
    requests = []
    async def handle(request):
        await request.aread(); requests.append(request)
        return httpx.Response(200, json={'ok': True})
    await gateway.close()
    gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    await gateway.request('di', 'center-edge', 'alice', 'GET', '/api/v1/datasources', headers={'authorization': 'attacker', 'x-tenant-id': 'other'})
    assert requests[-1].headers['authorization'] == 'Bearer ' + 'd'*32
    assert requests[-1].headers['x-tenant-id'] == 't1'
    body = b'{"purpose":"analysis"}'
    path = '/api/v1/objects/o/access?x=1'
    await gateway.request('ts', 'center-edge', 'alice', 'POST', path, body=body, headers={'idempotency-key': 'k'})
    h = requests[-1].headers
    canonical = '\n'.join(['bonfire-transit-v2', 'alice', 'transit-storage', h['x-ts-timestamp'], h['x-ts-nonce'], 'POST', path, 'k', hashlib.sha256(body).hexdigest()])
    assert h['x-ts-signature'] == hmac.new(b's'*32, canonical.encode(), hashlib.sha256).hexdigest()
    await gateway.close()


def test_missing_user_never_inherits_machine(gateway):
    with pytest.raises(DomainError) as exc: gateway.identity('center-edge', 'mallory')
    assert exc.value.status_code == 503
    with pytest.raises(DomainError): gateway.identity('other-edge', 'alice')


@pytest.mark.asyncio
async def test_proxy_preserves_errors_204_and_streaming_and_blocks_internal(gateway):
    seen = []
    async def upstream(request):
        await request.aread(); seen.append(request)
        if request.method == 'DELETE': return httpx.Response(204)
        if request.method == 'PUT': return httpx.Response(412, json={'error': 'revision_conflict'})
        return httpx.Response(200, content=b'payload', headers={'content-type': 'application/octet-stream'})
    await gateway.close(); gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app = FastAPI(); router = APIRouter()
    @app.middleware('http')
    async def identity(request, next): request.state.username = 'alice'; return await next(request)
    @app.exception_handler(DomainError)
    async def error(request, exc): return JSONResponse({'error': str(exc)}, status_code=exc.status_code)
    install(router, gateway, lambda _: 'center-edge'); app.include_router(router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://portal') as client:
        response = await client.get('/services/di/datasources/source/files?ref=a.csv')
        assert response.content == b'payload' and response.headers['cache-control'] == 'no-store'
        response = await client.delete('/services/dr/resources/r', headers={'if-match': '3'})
        assert response.status_code == 204 and response.content == b''
        response = await client.put('/services/dr/resources/r', json={}, headers={'if-match': '2'})
        assert response.status_code == 412 and seen[-1].headers['if-match'] == '2'
        for path in ['di/internal/v1/compute-transfers', 'dr/resources/r/versions/1/locator', 'dr/demo/resources/r/review', 'ts/business-tasks']:
            assert (await client.post('/services/'+path, json={})).status_code == 404
    await gateway.close()


@pytest.mark.asyncio
async def test_network_error_is_not_silently_retried(gateway):
    count = 0
    async def fail(request):
        nonlocal count
        count += 1
        raise httpx.ConnectError('hidden endpoint', request=request)
    await gateway.close(); gateway.client = httpx.AsyncClient(transport=httpx.MockTransport(fail))
    with pytest.raises(DomainError) as exc:
        await gateway.request('di', 'center-edge', 'alice', 'POST', '/api/v1/transfers', body=b'{}')
    assert str(exc.value) == 'di_unavailable' and count == 1
    await gateway.close()


def test_fresh_portal_database_contains_no_data_business_tables(tmp_path):
    from bonfire_portal.infrastructure.portal_database import PortalDatabase
    db = PortalDatabase(tmp_path / 'portal-services.sqlite')
    tables = {row[0] for row in db.connection().execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert tables == {'durable_record', 'application_image', 'portal_state'}


def test_identity_only_initialization_never_resumes_legacy_tasks(tmp_path):
    from bonfire_portal.infrastructure.database import Database
    from bonfire_portal.infrastructure.state import PortalState
    from bonfire_portal.infrastructure.portal_database import PortalDatabase
    from bonfire_portal.initialize import initialize
    old = Database(tmp_path / 'old.sqlite')
    PortalState(old).save_profile('alice', {'connector_id': 'edge', 'identity_dir': '/state/identity',
                                         'local_execution_runs': {'legacy-run': {'external_run_ref': 'old-job'}}})
    old.durable_write('extraction', 'old-task', {'state': 'running'}, 'running')
    dest = tmp_path / 'new.sqlite'; initialize(old.path, dest)
    new = PortalDatabase(dest)
    assert PortalState(new).profile('edge')['identity_dir'] == '/state/identity'
    assert 'local_execution_runs' not in PortalState(new).profile('edge')
    assert not new.durable_list('extraction')
    with pytest.raises(ValueError): initialize(old.path, dest)
