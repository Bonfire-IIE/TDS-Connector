"""Allowlisted browser gateway; internal machine APIs are never proxied."""
import re
from fastapi import Request
from fastapi.responses import Response, StreamingResponse
from starlette.background import BackgroundTask
from ...domain.errors import DomainError

ID = r'[A-Za-z0-9_-]+'
RULES = {
    'di': [
        ('GET', r'identity'), ('GET|POST', r'datasources'), ('POST', r'datasources/upload'),
        ('GET|DELETE', rf'datasources/{ID}'), ('POST', rf'datasources/{ID}/(?:probe|inspect)'),
        ('GET', rf'datasources/{ID}/objects'), ('GET|POST', rf'datasources/{ID}/files'),
        ('GET|POST', r'transfers'), ('GET', rf'transfers/{ID}(?:/items)?'),
        ('POST', rf'transfers/{ID}/(?:run|retry|cancel)'),
    ],
    'dr': [
        ('GET', r'identity|metadata-options|sources'), ('GET', rf'sources/{ID}/objects'),
        ('POST', rf'sources/{ID}/inspect'), ('GET|POST', r'resources'),
        ('GET|PUT|DELETE', rf'resources/{ID}'), ('GET', rf'resources/{ID}/(?:versions|audit|sync-status)'),
        ('POST', rf'resources/{ID}/(?:publish|sync)'),
    ],
    'ts': [
        ('GET', r'admin/summary'), ('GET|POST', r'admin/(?:warehouses|retention-policies)'),
        ('GET', rf'admin/(?:warehouses|retention-policies|lifecycle-jobs|anomalies|approvals|access-observations)(?:/{ID})?'),
        ('POST', rf'admin/retention-policies/{ID}/dry-run'),
        ('GET', rf'business-tasks(?:/{ID}|/by-reference/{ID})'), ('POST', rf'business-tasks/{ID}/cancel'),
        ('GET|POST', r'imports|grants'), ('GET', r'imports|objects|grants|accesses'), ('GET', rf'(?:imports|objects)/{ID}'),
        ('POST', rf'imports/{ID}/cancel|grants/{ID}/revoke|objects/{ID}/(?:access|restore)|accesses/{ID}/release'),
        ('DELETE', rf'objects/{ID}'),
        ('POST', rf'admin/objects/{ID}/(?:hold|unhold|purge|purge-approvals)'),
        ('POST', rf'admin/approvals/{ID}/approve|admin/lifecycle-jobs/{ID}/retry'),
    ],
}


def install(router, gateway, connector_id):
    @router.get('/services/capabilities')
    async def capabilities(request: Request):
        return await gateway.capabilities(connector_id(request), request.state.username)

    @router.api_route('/services/{service}/{target:path}', methods=['GET', 'POST', 'PUT', 'DELETE'])
    async def proxy(service: str, target: str, request: Request):
        if not any(request.method in methods.split('|') and re.fullmatch(pattern, target)
                   for methods, pattern in RULES.get(service, [])):
            raise DomainError(404, 'service_route_not_found')
        if not getattr(request.state, 'username', None): raise DomainError(401, 'browser_identity_required')
        path = '/api/v1/' + target
        if request.url.query: path += '?' + request.url.query
        # Streaming request forwarding is supported for uploads; signed TS JSON bodies are bounded.
        if service == 'ts':
            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > 1024 * 1024: raise DomainError(413, 'request_too_large')
            body = bytes(data)
        else:
            body = request.stream()
        response = await gateway.request(service, connector_id(request), request.state.username,
                                         request.method, path, body=body, headers=dict(request.headers), stream=True)
        headers = {k: v for k, v in response.headers.items()
                   if k.lower() in {'content-type', 'content-disposition', 'etag', 'retry-after', 'x-request-id'}}
        headers['Cache-Control'] = 'no-store'
        if response.status_code == 204:
            await response.aclose()
            return Response(status_code=204, headers=headers)
        return StreamingResponse(response.aiter_bytes(), status_code=response.status_code, headers=headers,
                                 background=BackgroundTask(response.aclose))
