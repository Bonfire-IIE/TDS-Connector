from types import SimpleNamespace
import pytest
from bonfire_portal.application import connectivity
from bonfire_portal.infrastructure.portal_database import PortalDatabase

@pytest.mark.asyncio
async def test_probe_requires_ready_route_and_actual_target_reachability(tmp_path,monkeypatch):
    class Lite:
        def __init__(self,*args):pass
        async def query_domain(self,*args):pass
        async def ensure_partner_domain(self,*args,**kwargs):pass
        async def create_route(self,*args,**kwargs):pass
        async def query_route(self,*args):return {'status':{'status':'Ready'}}
    class Writer:
        def close(self):pass
        async def wait_closed(self):pass
    async def connect(*args):return None,Writer()
    monkeypatch.setattr(connectivity,'LiteClient',Lite);monkeypatch.setattr(connectivity.asyncio,'open_connection',connect)
    db=PortalDatabase(tmp_path/'db.sqlite');profile={'domain_id':'a-domain','lite_kuscia_endpoint':'x','lite_cert_dir':'x'};body={'peer_identity':{'connector_id':'b','domain_id':'b-domain','cert':'cert'},'gateway_endpoint':'http://b:1080'}
    result=await connectivity.probe_connectivity(db,'a',profile,body)
    assert result['state']=='ready' and result['target_reachable']
    async def fail(*args):raise OSError('connection refused')
    monkeypatch.setattr(connectivity.asyncio,'open_connection',fail)
    result=await connectivity.probe_connectivity(db,'a',profile,body)
    assert result['state']=='failed' and not result['ready']
    assert db.durable_read('connectivity-probe','a:b')['state']=='failed'
