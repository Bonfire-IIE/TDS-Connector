"""Delegation commands cannot impersonate another connector or bypass browser auth."""
import json
from pathlib import Path

import httpx
import pytest
import respx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

from bonfire_portal.api import create_router
from bonfire_portal.config import Settings
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.database import Database


@pytest.fixture
def client(tmp_path: Path):
    settings = Settings(platform_api_base='http://center.test/api/v1', portal_data_dir=tmp_path, storage_root=tmp_path)
    app = FastAPI()
    app.state.connector_id = 'compute-a'
    app.include_router(create_router(settings, Database(tmp_path / 'portal.sqlite')))

    @app.exception_handler(DomainError)
    async def domain_error(_request, exc):
        return JSONResponse(status_code=exc.status_code, content={'detail': str(exc)})

    return TestClient(app)


def authenticate():
    respx.get('http://center.test/api/v1/identity/me').mock(
        return_value=httpx.Response(200, json={'code': 0, 'data': {'username': 'compute-owner'}}))
    respx.get('http://center.test/api/v1/connectors').mock(
        return_value=httpx.Response(200, json={'code': 0, 'data': [{'id': 'compute-a'}]}))


@respx.mock
def test_inbox_binds_authenticated_connector_and_forwards_token(client):
    authenticate()
    route = respx.get('http://center.test/api/v1/computation-delegations/inbox', params={'connector_id': 'compute-a'}).mock(
        return_value=httpx.Response(200, json={'code': 0, 'data': [{'id': 'd1', 'status': 'revoked'}]}))
    response = client.get('/portal/computation-delegations?connector_id=other', headers={'Authorization': 'Bearer token'})
    assert response.status_code == 200
    assert response.json()['data'] == [{'id': 'd1', 'status': 'revoked'}]
    assert route.calls[0].request.headers['Authorization'] == 'Bearer token'


@respx.mock
def test_decision_ignores_browser_identity_override_and_preserves_conflict(client):
    authenticate()
    route = respx.post('http://center.test/api/v1/computation-delegations/d1/decision').mock(
        return_value=httpx.Response(409, json={'detail': '委托已撤回'}))
    response = client.post('/portal/computation-delegations/d1/decision', json={
        'connector_id': 'other', 'decision': 'accepted', 'status': 'active'}, headers={'Authorization': 'Bearer token'})
    assert response.status_code == 409
    assert response.json()['detail'] == '委托已撤回'
    assert json.loads(route.calls[0].request.content) == {'connector_id': 'compute-a', 'decision': 'accepted'}


@pytest.mark.parametrize('payload', [{'decision': 'active'}, {'decision': 'revoked'}, [], None])
@respx.mock
def test_decision_rejects_invalid_commands(client, payload):
    authenticate()
    response = client.post('/portal/computation-delegations/d1/decision', json=payload, headers={'Authorization': 'Bearer token'})
    assert response.status_code == 422


def test_inbox_and_decision_require_authentication(client):
    assert client.get('/portal/computation-delegations').status_code == 401
    assert client.post('/portal/computation-delegations/d1/decision', json={'decision': 'accepted'}).status_code == 401


def test_local_receipt_binds_scope_connector_versions_and_expiry(tmp_path):
    from datetime import datetime, timedelta, timezone
    from bonfire_portal.application.delegations import store_receipt, validate_receipt
    database = Database(tmp_path / 'receipts.sqlite')
    delegation = {'id': 'd1', 'status': 'pending', 'scope_hash': 'frozen-hash',
                  'expires_at': (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                  'scope': {'instances': [{'id': 'inference', 'version_id': 'version-1'}],
                            'participants': [{'connector_id': 'compute-a', 'roles': ['compute_1']}]}}
    request = {'delegation_snapshot': {'id': 'd1', 'scope_hash': 'frozen-hash'},
               'workflow': {'nodes': [{'id': 'compute', 'template_version': 'version-1',
                                       'parties': [{'domain_id': 'compute-a', 'role': 'p0'}]}]}}
    with pytest.raises(DomainError, match='尚未接受'):
        validate_receipt(database, 'compute-a', request)
    store_receipt(database, 'compute-a', delegation, 'accepted')
    validate_receipt(database, 'compute-a', request)
    request['delegation_snapshot']['scope_hash'] = 'changed'
    with pytest.raises(DomainError, match='范围不一致'):
        validate_receipt(database, 'compute-a', request)
    request['delegation_snapshot']['scope_hash'] = 'frozen-hash'
    request['workflow']['nodes'][0]['template_version'] = 'version-2'
    with pytest.raises(DomainError, match='应用版本'):
        validate_receipt(database, 'compute-a', request)
    request['workflow']['nodes'][0]['template_version'] = 'version-1'
    delegation['status'] = 'revoked'
    store_receipt(database, 'compute-a', delegation)
    with pytest.raises(DomainError, match='已失效'):
        validate_receipt(database, 'compute-a', request)
    delegation['status'] = 'active'
    delegation['expires_at'] = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    store_receipt(database, 'compute-a', delegation)
    with pytest.raises(DomainError, match='已过期'):
        validate_receipt(database, 'compute-a', request)
