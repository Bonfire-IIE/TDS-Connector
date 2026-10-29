"""Center-authorized directional engine route and target connectivity probes."""
import asyncio
from datetime import datetime,timezone
from urllib.parse import urlsplit
from ..domain.errors import DomainError
from ..infrastructure.kuscia import LiteClient

async def probe_connectivity(database,connector_id,profile,body):
    if not profile or not profile.get('domain_id'):raise DomainError(409,'本地计算引擎未接入')
    peer=body.get('peer_identity') or {}; peer_id=str(peer.get('connector_id') or '')
    domain=str(peer.get('domain_id') or '');gateway=str(body.get('gateway_endpoint') or '')
    if not peer_id or peer_id==connector_id or not domain or not peer.get('cert'):raise DomainError(422,'对端引擎身份不完整')
    parsed=urlsplit(gateway)
    if parsed.scheme not in {'http','https'} or not parsed.hostname or parsed.username or parsed.password:raise DomainError(422,'对端网关地址无效')
    key=connector_id+':'+peer_id
    value={'src':connector_id,'dst':peer_id,'source_domain':profile['domain_id'],'target_domain':domain,'state':'probing','ready':False,'checked_at':datetime.now(timezone.utc).isoformat()}
    database.durable_write('connectivity-probe',key,value,'probing')
    try:
        engine=LiteClient(profile['lite_kuscia_endpoint'],profile['lite_cert_dir'])
        await engine.query_domain(profile['domain_id'])
        if body.get('scheduling_mode')=='master-lite':
            # Topology belongs to Master.  Lite proves only its own engine and
            # the outbound target; it never creates partner Domains/routes.
            state=str(body.get('master_route_state') or '')
        else:
            await engine.ensure_partner_domain(domain,peer['cert'],allow_certificate_update=True)
            await engine.create_route(profile['domain_id'],domain,parsed.hostname,parsed.port or (443 if parsed.scheme=='https' else 80),parsed.scheme=='https')
            route=await engine.query_route(profile['domain_id'],domain)
            status=(route or {}).get('status') or {}
            state=str(status.get('status') or status.get('phase') or '')
        value['route_state']=state
        if state.casefold() not in {'ready','succeeded'}:raise RuntimeError('引擎路由尚未Ready: '+(state or 'unknown'))
        _,writer=await asyncio.wait_for(asyncio.open_connection(parsed.hostname,parsed.port or (443 if parsed.scheme=='https' else 80)),timeout=5)
        writer.close();await writer.wait_closed()
        value.update(state='ready',ready=True,target_reachable=True)
    except Exception as exc:value.update(state='failed',ready=False,reason=str(exc)[:400])
    value['checked_at']=datetime.now(timezone.utc).isoformat()
    database.durable_write('connectivity-probe',key,value,value['state'])
    return value
