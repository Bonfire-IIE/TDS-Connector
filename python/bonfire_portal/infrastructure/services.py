"""HTTP-only service boundary. No service databases or domain imports."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any

import httpx
from ..domain.errors import DomainError


class ServiceGateway:
    def __init__(self, settings, client=None):
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(30, connect=5), trust_env=False, follow_redirects=False)

    async def close(self):
        await self.client.aclose()

    def identity(self, connector: str, username: str | None = None) -> dict:
        try:
            config = json.loads(Path(self.settings.service_identities_file).read_text())
            identity = (config.get('users', {}).get(connector, {}).get(username)
                        if username else config.get('machines', {}).get(connector))
            if not identity or not all(re.fullmatch(r'[A-Za-z0-9_-]{1,64}', str(identity.get(k, '')))
                                       for k in ('tenant_id', 'connector_id')):
                raise ValueError()
            return identity
        except (OSError, ValueError, TypeError, KeyError):
            raise DomainError(503, 'service_identity_not_configured') from None

    async def request(self, service: str, connector: str, username: str | None, method: str,
                      path: str, *, body: bytes = b'', headers: dict | None = None, stream=False):
        identity = self.identity(connector, username)
        binding = identity.get(service) or {}
        base = getattr(self.settings, service + '_url', '').rstrip('/')
        if not base or not binding:
            raise DomainError(503, 'service_not_configured')
        outbound = {k: v for k, v in (headers or {}).items()
                    if k.lower() in {'content-type', 'idempotency-key', 'if-match', 'x-request-id'}}
        outbound['X-Request-ID'] = outbound.get('x-request-id') or secrets.token_hex(16)
        if service == 'ts':
            secret = os.getenv(binding.get('secret_env', ''), '')
            signer = binding.get('signer', '')
            if len(secret) < 32 or not signer:
                raise DomainError(503, 'service_identity_not_configured')
            stamp, nonce = str(int(time.time())), secrets.token_hex(24)
            canonical = '\n'.join(['bonfire-transit-v2', signer, 'transit-storage', stamp, nonce,
                                    method.upper(), path, outbound.get('idempotency-key', ''), hashlib.sha256(body).hexdigest()])
            outbound.update({'X-TS-Signer': signer, 'X-TS-Recipient': 'transit-storage', 'X-TS-Timestamp': stamp,
                             'X-TS-Nonce': nonce, 'X-TS-Signature': hmac.new(secret.encode(), canonical.encode(), hashlib.sha256).hexdigest()})
        else:
            token = os.getenv(binding.get('token_env', ''), '')
            if len(token) < 32:
                raise DomainError(503, 'service_identity_not_configured')
            outbound.update({'Authorization': 'Bearer ' + token, 'X-Tenant-ID': identity['tenant_id'],
                             'X-Connector-ID': identity['connector_id']})
        try:
            request = self.client.build_request(method, base + path, content=body, headers=outbound)
            return await self.client.send(request, stream=stream)
        except httpx.HTTPError:
            raise DomainError(503, service + '_unavailable') from None

    async def json(self, service, connector, method, path, payload=None, *, username=None, key=None):
        headers = {'content-type': 'application/json'}
        if key: headers['idempotency-key'] = key
        response = await self.request(service, connector, username, method, path,
                                      body=json.dumps(payload).encode() if payload is not None else b'', headers=headers)
        if response.status_code >= 400:
            # Do not copy arbitrary upstream diagnostic data into task logs.
            raise DomainError(response.status_code, service + '_request_failed')
        if response.status_code == 204: return None
        return response.json()

    async def capabilities(self, connector, username):
        identity = self.identity(connector, username)
        result = {'tenant_id': identity['tenant_id'], 'connector_id': identity['connector_id'], 'services': {}}
        for service in ('di', 'dr', 'ts'):
            binding = identity.get(service, {})
            try:
                if service == 'ts':
                    # TS enforces its own roles. Display roles are deployment mapping, never browser claims.
                    result['services'][service] = {'roles': binding.get('roles', []), 'configured': bool(binding and self.settings.ts_url)}
                else:
                    value = await self.json(service, connector, 'GET', '/api/v1/identity', username=username)
                    if (value['tenant_id'], value['connector_id']) != (identity['tenant_id'], identity['connector_id']):
                        raise DomainError(503, 'service_scope_mismatch')
                    result['services'][service] = {'roles': value['roles'], 'configured': True}
            except DomainError as exc:
                result['services'][service] = {'roles': [], 'configured': False, 'error': str(exc)}
        return result
