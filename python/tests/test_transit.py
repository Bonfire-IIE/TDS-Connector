import hashlib
import hmac
import json

import httpx
import pytest
import respx

from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.transit import transit_request


@pytest.fixture
def identity(monkeypatch):
    monkeypatch.setenv('PORTAL_TRANSIT_IDENTITIES', json.dumps({
        'connector-a:alice': {'signer': 'alice-a', 'secret_env': 'TEST_TRANSIT_SECRET'},
    }))
    monkeypatch.setenv('TEST_TRANSIT_SECRET', 's' * 32)
    monkeypatch.setenv('PORTAL_TRANSIT_URL', 'http://transit.test')
    monkeypatch.setenv('PORTAL_TRANSIT_DI_URL', 'http://di.test')


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize('integration,base,target,recipient', [
    (False, 'http://transit.test', '/api/v1/imports?limit=2', 'transit-storage'),
    (True, 'http://di.test', '/internal/v1/sources', 'data-integration'),
])
async def test_signature_binds_identity_recipient_target_and_body(identity, integration, base, target, recipient):
    route = respx.post(base + target).mock(return_value=httpx.Response(200, json={'id': 'created'}))
    body = b'{"purpose":"analysis"}'
    result = await transit_request('connector-a', 'alice', 'POST', target, body, 'request-1', integration)
    assert result == {'id': 'created'}
    request = route.calls.last.request
    headers = request.headers
    message = '\n'.join(['bonfire-transit-v2', 'alice-a', recipient,
        headers['X-TS-Timestamp'], headers['X-TS-Nonce'], 'POST', target, 'request-1',
        hashlib.sha256(body).hexdigest()]).encode()
    assert headers['X-TS-Signature'] == hmac.new(b's' * 32, message, hashlib.sha256).hexdigest()
    assert headers['X-TS-Recipient'] == recipient
    assert headers['Idempotency-Key'] == 'request-1'
    assert request.content == body


@pytest.mark.asyncio
@respx.mock
@pytest.mark.parametrize('connector,username', [('connector-b', 'alice'), ('connector-a', 'bob')])
async def test_no_identity_fallback(identity, connector, username):
    with pytest.raises(DomainError) as error:
        await transit_request(connector, username, 'GET', '/api/v1/objects', b'')
    assert error.value.status_code == 503
    assert not respx.calls


@pytest.mark.asyncio
@respx.mock
async def test_upstream_denial_preserved(identity):
    respx.get('http://transit.test/api/v1/objects').mock(
        return_value=httpx.Response(403, json={'error': 'forbidden'}))
    with pytest.raises(DomainError, match='forbidden') as error:
        await transit_request('connector-a', 'alice', 'GET', '/api/v1/objects', b'')
    assert error.value.status_code == 403


def test_transit_routes_construct(tmp_path):
    from bonfire_portal.api import create_router
    from bonfire_portal.config import Settings
    from bonfire_portal.infrastructure.database import Database
    router = create_router(Settings(portal_data_dir=tmp_path, storage_root=tmp_path),
                           Database(tmp_path / 'portal.sqlite'))
    paths = {route.path for route in router.routes}
    assert '/portal/services/{service}/{target:path}' in paths
    assert '/portal/transit/{target:path}' not in paths
