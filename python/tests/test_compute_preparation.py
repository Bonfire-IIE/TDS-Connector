import hashlib
import json
import hashlib
import json
import time
from copy import deepcopy
from types import SimpleNamespace

import pytest
from bonfire_portal.application.extraction import ExtractionService
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.portal_database import PortalDatabase


@pytest.fixture
def preparation(tmp_path, monkeypatch):
    payload = b'id\n1\n'
    class Lite:
        sessions = 0
        registrations = {}
        def __init__(self, *_): pass
        async def ftp_request(self, method, path, body=None):
            if method == 'POST' and path == '':
                self.__class__.sessions += 1
                return {'session': {'id': 'session', 'expires_at': time.time()+300}, 'username': 'user', 'password': 'private', 'directory': '/result'}
            if path.endswith('/files'):
                return {'files': [{'path': 'data.csv', 'sha256': hashlib.sha256(payload).hexdigest(), 'size': len(payload)}]}
            if path.endswith('/complete'): return {'relative_uri': 'staging/session/files'}
            return {'state': 'uploading'}
        async def create_domain_data(self, **kwargs): self.registrations[kwargs['data_id']] = kwargs
        async def query_domain_data(self, _, identifier): return self.registrations[identifier]
        async def download_file(self, _): return payload, None
    monkeypatch.setattr('bonfire_portal.application.extraction.LiteClient', Lite)
    class Gateway:
        def __init__(self): self.task = None; self.locates = 0; self.creates = 0; self.lose_response = False; self.reject_location = False
        async def json(self, service, connector, method, path, value=None, **kwargs):
            if service == 'dr':
                self.locates += 1
                if self.reject_location: raise DomainError(409, 'resource_version_not_published')
                return {'resource_id': 'resource', 'version': 2, 'source_id': 'di-source', 'object_ref': 'table.csv',
                        'resource_format': 'CSV', 'data_items': [{'name': 'id', 'type': 'string'}]}
            if method == 'GET':
                if not self.task: raise DomainError(404, 'not_found')
                return self.task
            if path.endswith('/cancel'): self.task['state'] = 'cancelled'; return self.task
            assert value['source_id'] == 'di-source' and value['object_ref'] == 'table.csv'
            assert value['password'] == 'private'
            self.creates += 1; self.task = {'id': 'delivery', 'job_id': '123', 'state': 'succeeded'}
            if self.lose_response: raise DomainError(503, 'response_lost')
            return self.task
    gateway = Gateway()
    settings = SimpleNamespace(compute_target_binding='kuscia', engine_upload_host='ftp', engine_upload_port=21, engine_upload_backend='directory')
    db = PortalDatabase(tmp_path / 'portal.sqlite')
    service = ExtractionService(db, settings, gateway)
    profile = {'domain_id': 'domain', 'engine_datasource_ref': 'storage', 'lite_kuscia_endpoint': 'http://kuscia', 'lite_cert_dir': '/certs'}
    body = {'request_key': 'attempt', 'resource_ref': 'resource', 'resource_version': 'V2', 'dr_resource_id': 'resource', 'output_format': 'csv'}
    return service, gateway, profile, body, Lite


@pytest.mark.asyncio
async def test_compute_uses_dr_binding_and_never_persists_ftp_password(preparation):
    service, gateway, profile, body, lite = preparation
    task = service.create(deepcopy(body), 'edge', profile)
    result = await service.run(task['id'], 'edge', profile)
    assert result['state'] == 'ready' and result['di_task_id'] == 'delivery'
    assert gateway.locates == 1 and gateway.creates == 1
    assert 'private' not in json.dumps(service.task(task['id'], 'edge'))
    assert service.create(body, 'edge', profile)['id'] == task['id']
    await service.run(task['id'], 'edge', profile)
    assert gateway.locates == 1 and lite.sessions == 1


@pytest.mark.asyncio
async def test_lost_di_response_recovers_without_rebinding_or_new_session(preparation):
    service, gateway, profile, body, lite = preparation
    task = service.create(body, 'edge', profile); gateway.lose_response = True
    with pytest.raises(DomainError): await service.run(task['id'], 'edge', profile)
    # New Portal process, same durable records. DR may now be delisted.
    gateway.reject_location = True
    restarted = ExtractionService(service.db, service.settings, gateway)
    result = await restarted.run(task['id'], 'edge', profile)
    assert result['state'] == 'ready'
    assert gateway.locates == 1 and gateway.creates == 1 and lite.sessions == 1


@pytest.mark.asyncio
async def test_unpublished_resource_never_opens_compute_session(preparation):
    service, gateway, profile, body, lite = preparation
    gateway.reject_location = True
    task = service.create(body, 'edge', profile)
    with pytest.raises(DomainError): await service.run(task['id'], 'edge', profile)
    assert lite.sessions == 0 and gateway.creates == 0
    assert service.task(task['id'], 'edge')['state'] == 'failed'


@pytest.mark.asyncio
@pytest.mark.parametrize('frozen_state', ['committing', 'staged'])
async def test_interrupted_commit_resumes_from_frozen_manifest(preparation, monkeypatch, frozen_state):
    from bonfire_portal.infrastructure.kuscia import KusciaError
    service, gateway, profile, body, lite = preparation
    original = lite.ftp_request
    files = [{'path': 'data.csv', 'sha256': hashlib.sha256(b'id\n1\n').hexdigest(), 'size': 5}]
    frozen = False
    commits = 0

    async def request(self, method, path, value=None):
        nonlocal frozen, commits
        if path == '/session' and frozen:
            return {'state': frozen_state, 'files': files}
        if path.endswith('/files') and frozen:
            raise AssertionError('Frozen session must not be inventoried again')
        if path.endswith('/complete'):
            commits += 1
            assert value['files'] == files
            if commits == 1:
                frozen = True
                raise KusciaError('publication acknowledgement lost', 502)
        return await original(self, method, path, value)

    monkeypatch.setattr(lite, 'ftp_request', request)
    task = service.create(body, 'edge', profile)
    with pytest.raises(KusciaError):
        await service.run(task['id'], 'edge', profile)
    restarted = ExtractionService(service.db, service.settings, gateway)
    result = await restarted.run(task['id'], 'edge', profile)
    assert result['state'] == 'ready'
    assert commits == 2 and gateway.creates == 1 and lite.sessions == 1


@pytest.mark.asyncio
async def test_raw_single_file_uses_no_csv_schema_and_registers_file(preparation, monkeypatch):
    service, gateway, profile, body, lite = preparation
    body = {**body, 'output_format':'bin', 'content_mode':'raw'}
    original_json, original_ftp = gateway.json, lite.ftp_request
    async def json_call(service, connector, method, path, value=None, **kwargs):
        if service == 'dr':
            return {'resource_id':'resource','version':2,'source_id':'di-source','object_ref':'model.bin',
                    'resource_format':'BIN','data_items':[]}
        if method == 'POST' and not path.endswith('/cancel'):
            assert value['delivery_mode'] == 'raw' and value['columns'] == []
            assert value['input_format'] == 'bin'
            gateway.task = {'id':'delivery','job_id':'123','state':'succeeded'}
            return gateway.task
        return await original_json(service,connector,method,path,value,**kwargs)
    async def ftp_call(self, method, path, body=None):
        if method == 'POST' and path == '':
            assert body['format'] == 'raw' and body['columns'] == [] and body['header'] is False
        return await original_ftp(self,method,path,body)
    monkeypatch.setattr(gateway,'json',json_call)
    monkeypatch.setattr(lite,'ftp_request',ftp_call)
    task=service.create(body,'edge',profile)
    result=await service.run(task['id'],'edge',profile)
    assert result['state'] == 'ready' and result['resources'][0]['format'] == 'bin'
    registered=next(iter(lite.registrations.values()))
    assert registered['data_type'] == 'file' and registered['columns'] == []


@pytest.mark.asyncio
async def test_raw_format_cannot_relabel_resource_bytes(preparation):
    service,gateway,profile,body,lite=preparation
    task=service.create({**body,'output_format':'bin','content_mode':'raw'},'edge',profile)
    with pytest.raises(DomainError,match='raw_compute_format_must_match_resource'):
        await service.run(task['id'],'edge',profile)
    assert lite.sessions == 0


@pytest.mark.asyncio
async def test_explicit_run_release_deletes_only_owned_ingestion_metadata(preparation,monkeypatch):
    service,gateway,profile,body,lite=preparation
    task=service.create(body,'edge',profile);task=await service.run(task['id'],'edge',profile)
    deleted=[]; original=lite.ftp_request
    async def remove(self,domain,identifier):
        deleted.append((domain,identifier));self.registrations.pop(identifier,None)
    async def ftp(self,method,path,body=None):
        if path.endswith('/cleanup'):assert body['release'] is True and body['proof']['references_clear'] is True and deleted
        return await original(self,method,path,body)
    monkeypatch.setattr(lite,'delete_domain_data',remove,raising=False);monkeypatch.setattr(lite,'ftp_request',ftp)
    result=await service.cleanup(task['id'],'edge',profile,release=True,release_proof=release_proof(task))
    assert result['state']=='cleaned' and deleted==[('domain',task['id']+'-0')]


@pytest.mark.asyncio
async def test_explicit_release_rejects_replaced_domain_data(preparation,monkeypatch):
    service,gateway,profile,body,lite=preparation
    task=service.create(body,'edge',profile);task=await service.run(task['id'],'edge',profile)
    lite.registrations[task['id']+'-0']['attributes']['ftp_session_id']='other-session'
    async def remove(*args):raise AssertionError('must not delete another session resource')
    monkeypatch.setattr(lite,'delete_domain_data',remove,raising=False)
    with pytest.raises(DomainError,match='ownership_mismatch'):
        await service.cleanup(task['id'],'edge',profile,release=True,release_proof=release_proof(task))
    assert service.task(task['id'],'edge')['state']=='ready'


def release_proof(task):
    refs=sorted({task['id'],task['session_id'],*(r['engine_input_id'] for r in task['resources'])})
    return {'references_clear':True,'reference_scope':refs,'reference_hash':hashlib.sha256(json.dumps(refs,separators=(',',':')).encode()).hexdigest()}
