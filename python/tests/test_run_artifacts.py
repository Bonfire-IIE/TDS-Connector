import hashlib
import json
from types import SimpleNamespace
import pytest
from bonfire_portal.application import run_artifacts
from bonfire_portal.application.run_artifacts import owned_path,reconcile_artifacts
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.portal_database import PortalDatabase

def proof(run='r', refs=()):
    return {'job_id':'kuscia-'+hashlib.sha256(run.encode()).hexdigest()[:28],'terminal':True,'completed':True,'created_task_ids':[],'never_created_task_ids':[],'references_clear':True,'reference_scope':sorted(refs),'reference_hash':hashlib.sha256(json.dumps(sorted(refs),separators=(',',':')).encode()).hexdigest()}


@pytest.mark.parametrize('path', ['/projects/p/r/a.bin','projects/p/r/../a.bin','projects/p/r2/a.bin','projects/p/r/a\\b','projects/p/r/a\x00b'])
def test_artifact_paths_cannot_escape_run_workspace(path):
    with pytest.raises(DomainError):owned_path(path,'p','r')

@pytest.mark.parametrize('project,run',[('../p','r'),('p','../r'),('p','/r'),('p','r/x')])
def test_artifact_workspace_identifiers_are_single_segments(project,run):
    with pytest.raises(DomainError):owned_path('projects/p/r/a.bin',project,run)

@pytest.mark.asyncio
async def test_artifact_cleanup_is_idempotent_and_preserves_retained_outputs(tmp_path,monkeypatch):
    calls=[]
    class Lite:
        def __init__(self,*args):pass
        async def download_file(self,path):return b'\x00\xff\x80',None
        async def delete_file(self,path):calls.append(path)
    monkeypatch.setattr(run_artifacts,'LiteClient',Lite)
    record={'request':{'project_id':'p','artifact_plan':[
        {'connector_id':'edge','relative_uri':'projects/p/r/tmp.bin','retention':'temporary'},
        {'connector_id':'edge','relative_uri':'projects/p/r/result.bin','retention':'retained'},
        {'connector_id':'other','relative_uri':'projects/p/r/other.bin','retention':'temporary'}]},
        'prepared_manifests':{'a':{'ingestion_task_id':'input'}}}
    db=PortalDatabase(tmp_path/'portal.sqlite')
    executions=SimpleNamespace(db=db,get=lambda *_:record)
    class Extraction:
        count=0
        def task(self,*args):return {'state':'cleaned' if self.count else 'ready'}
        async def cleanup(self,*args,**kwargs):self.count+=1
    extraction=Extraction();profile={'lite_kuscia_endpoint':'x','lite_cert_dir':'x'}
    verified=await reconcile_artifacts(executions,extraction,'r','edge',profile,'verify')
    assert len(verified['receipts'])==2
    assert verified['receipts'][0]['sha256']==hashlib.sha256(b'\x00\xff\x80').hexdigest()
    first=await reconcile_artifacts(executions,extraction,'r','edge',profile,'cleanup',proof(refs=['input']))
    second=await reconcile_artifacts(executions,extraction,'r','edge',profile,'cleanup',proof(refs=['input']))
    assert first==second and calls==['projects/p/r/tmp.bin'] and extraction.count==1
    with pytest.raises(DomainError,match='已释放'):
        await reconcile_artifacts(executions,extraction,'r','edge',profile,'verify')

@pytest.mark.asyncio
async def test_cleanup_covers_pending_preparation_and_retries_real_failure(tmp_path,monkeypatch):
    class Lite:
        def __init__(self,*args):pass
    monkeypatch.setattr(run_artifacts,'LiteClient',Lite)
    db=PortalDatabase(tmp_path/'portal.sqlite')
    record={'request':{'project_id':'p','artifact_plan':[]},'extraction_task_ids':['pending'],'prepared_manifests':{}}
    executions=SimpleNamespace(db=db,get=lambda *_:record)
    class Extraction:
        state='running';cancelled=0;cleaned=0;fail=True
        def task(self,*args):return {'state':self.state}
        async def cancel(self,*args):self.cancelled+=1;self.state='cancelled'
        async def cleanup(self,*args,**kwargs):
            if self.fail:raise DomainError(503,'real_cleanup_failure')
            self.cleaned+=1;self.state='cleaned'
    extraction=Extraction();profile={'lite_kuscia_endpoint':'x','lite_cert_dir':'x'}
    with pytest.raises(DomainError,match='real_cleanup_failure'):
        await reconcile_artifacts(executions,extraction,'r','edge',profile,'cleanup',proof(refs=['pending']))
    assert db.durable_read('run_artifacts','r:edge') is None
    extraction.fail=False
    result=await reconcile_artifacts(executions,extraction,'r','edge',profile,'cleanup',proof(refs=['pending']))
    assert result['state']=='cleaned' and extraction.cancelled==1 and extraction.cleaned==1

@pytest.mark.asyncio
@pytest.mark.parametrize('master_valid,local_ready',[(False,True),(True,False),(True,True)])
async def test_cleanup_requires_bound_master_proof_and_local_quiescence(tmp_path,monkeypatch,master_valid,local_ready):
    from bonfire_portal.application.execution import _engine_task_id
    calls=[]
    class Lite:
        def __init__(self,*args):pass
        async def task_quiescence(self,task_ids):
            calls.append(('proof',task_ids));return {'ready':local_ready,'task_ids':task_ids}
        async def delete_file(self,path):calls.append(('delete',path))
    monkeypatch.setattr(run_artifacts,'LiteClient',Lite)
    request={'project_id':'p','workflow':{'nodes':[{'id':'first','parties':[{'domain_id':'edge'}]}]},'artifact_plan':[{'connector_id':'edge','relative_uri':'projects/p/r/temp.bin','retention':'temporary'}]}
    db=PortalDatabase(tmp_path/'portal.sqlite');executions=SimpleNamespace(db=db,get=lambda *_:{'request':request})
    stop=proof();stop['created_task_ids']=[_engine_task_id(stop['job_id'],'first')]
    if not master_valid:stop['job_id']='different-job'
    args=(executions,None,'r','edge',{'lite_kuscia_endpoint':'x','lite_cert_dir':'x'},'cleanup',stop)
    if not master_valid or not local_ready:
        with pytest.raises(DomainError):await reconcile_artifacts(*args)
        assert not any(c[0]=='delete' for c in calls)
        assert db.durable_read('run_artifacts','r:edge') is None
    else:
        result=await reconcile_artifacts(*args)
        assert result['state']=='cleaned' and result['stop_receipt']['ready'] is True
        assert calls[-1]==('delete','projects/p/r/temp.bin')

@pytest.mark.asyncio
async def test_cleanup_never_accepts_only_tasks_stopped_without_master_receipt(tmp_path,monkeypatch):
    class Lite:
        def __init__(self,*args):pass
    monkeypatch.setattr(run_artifacts,'LiteClient',Lite)
    db=PortalDatabase(tmp_path/'portal.sqlite');executions=SimpleNamespace(db=db,get=lambda *_:{'request':{'project_id':'p'}})
    with pytest.raises(DomainError,match='停止证明'):
        await reconcile_artifacts(executions,None,'r','edge',{'lite_kuscia_endpoint':'x','lite_cert_dir':'x'},'cleanup')

@pytest.mark.asyncio
async def test_reference_hash_must_match_before_any_file_deletion(tmp_path,monkeypatch):
    class Lite:
        def __init__(self,*args):pass
        async def delete_file(self,*args):raise AssertionError('must validate proof before deletion')
    monkeypatch.setattr(run_artifacts,'LiteClient',Lite)
    db=PortalDatabase(tmp_path/'portal.sqlite')
    record={'request':{'project_id':'p','artifact_plan':[{'connector_id':'edge','relative_uri':'projects/p/r/tmp.bin','retention':'temporary'}]}}
    stop=proof();stop['reference_hash']='wrong'
    with pytest.raises(DomainError,match='输入引用停止证明'):
        await reconcile_artifacts(SimpleNamespace(db=db,get=lambda *_:record),None,'r','edge',{'lite_kuscia_endpoint':'x','lite_cert_dir':'x'},'cleanup',stop)
