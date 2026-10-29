"""Thin authenticated TS transport; no local transit state or cross-service joins."""
import hashlib
import hmac
import json
import os
import secrets
import time
import httpx
from ..domain.errors import DomainError


async def transit_request(connector_id, username, method, target, body, idempotency_key=None, integration=False):
    identity = json.loads(os.getenv('PORTAL_TRANSIT_IDENTITIES', '{}')).get(connector_id+':'+username)
    base = os.getenv('PORTAL_TRANSIT_DI_URL' if integration else 'PORTAL_TRANSIT_URL', '').rstrip('/')
    recipient = 'data-integration' if integration else 'transit-storage'
    if not identity or not base: raise DomainError(503, '当前用户尚未配置中转仓服务身份')
    secret = os.getenv(identity['secret_env'], '')
    if len(secret) < 32: raise DomainError(503, '中转仓服务身份不可用')
    signer, stamp, nonce = identity['signer'], str(int(time.time())), secrets.token_hex(24)
    message = '\n'.join(['bonfire-transit-v2', signer, recipient, stamp, nonce, method,
                         target, idempotency_key or '', hashlib.sha256(body).hexdigest()]).encode()
    headers = {'X-TS-Signer': signer, 'X-TS-Recipient': recipient, 'X-TS-Timestamp': stamp,
               'X-TS-Nonce': nonce, 'X-TS-Signature': hmac.new(secret.encode(), message, hashlib.sha256).hexdigest(),
               'Content-Type': 'application/json'}
    if idempotency_key: headers['Idempotency-Key'] = idempotency_key
    try:
        async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
            response = await client.request(method, base+target, content=body, headers=headers)
    except httpx.HTTPError as exc: raise DomainError(503, '中转仓服务暂不可用') from exc
    if response.status_code >= 400:
        try: code = response.json().get('error', 'transit_request_failed')
        except ValueError: code = 'transit_request_failed'
        raise DomainError(response.status_code, code)
    return response.json()
