"""Domain-local verification and release of declared run files."""
from __future__ import annotations
import hashlib
import json
from pathlib import PurePosixPath
from ..domain.errors import DomainError
from ..infrastructure.kuscia import LiteClient, KusciaError

def owned_path(path,project_id,run_id):
    if any(not isinstance(v,str) or not v or '/' in v or '\\' in v or v in {'.','..'} or any(ord(c)<32 for c in v) for v in (project_id,run_id)):
        raise DomainError(403,'产物工作区标识无效')
    if any(ord(c)<32 for c in str(path)):
        raise DomainError(403,'产物路径包含非法字符')
    p=PurePosixPath(str(path));prefix=PurePosixPath('projects')/project_id/run_id
    if p.is_absolute() or '..' in p.parts or '\\' in str(p) or not str(p).startswith(str(prefix)+'/'):
        raise DomainError(403,'产物路径不在本次执行工作区')
    return str(p)

async def reconcile_artifacts(executions,extraction,run_id,connector_id,profile,phase,stop_proof=None):
    if phase not in {'scope','verify','cleanup'}:raise DomainError(422,'invalid_artifact_phase')
    record=executions.get(run_id,connector_id)
    if not record:raise DomainError(404,'本域尚未准备该执行')
    task_ids=set(record.get('extraction_task_ids') or [])
    task_ids.update(m.get('ingestion_task_id') for m in (record.get('prepared_manifests') or {}).values())
    reference_scope=[]
    if extraction:
        for task_id in sorted(t for t in task_ids if t):
            task=extraction.task(task_id,connector_id)
            reference_scope.append(task_id)
            if task.get('session_id'):reference_scope.append(task['session_id'])
            reference_scope.extend(str(r['engine_input_id']) for r in task.get('resources') or [])
    reference_scope=sorted(set(reference_scope))
    if phase=='scope':return {'run_id':run_id,'connector_id':connector_id,'reference_scope':reference_scope}
    previous=executions.db.durable_read('run_artifacts',run_id+':'+connector_id)
    if previous and previous.get('state')=='cleaned':
        if phase=='cleanup':return previous
        raise DomainError(409,'本次执行产物已释放')
    request=record['request'];project_id=request['project_id']
    client=LiteClient(profile['lite_kuscia_endpoint'],profile['lite_cert_dir'])
    local_stop=None
    if phase=='cleanup':
        proof_scope=stop_proof.get('reference_scope') if isinstance(stop_proof,dict) else None
        if (not isinstance(proof_scope,list) or not all(isinstance(r,str) for r in proof_scope)
                or len(proof_scope)!=len(set(proof_scope)) or not set(reference_scope)<=set(proof_scope)
                or stop_proof.get('references_clear') is not True
                or stop_proof.get('reference_hash')!=hashlib.sha256(json.dumps(sorted(proof_scope),separators=(',',':')).encode()).hexdigest()):
            raise DomainError(409,'输入引用停止证明范围不匹配')
        from .execution import _engine_task_id
        job_id='kuscia-'+hashlib.sha256(run_id.encode()).hexdigest()[:28]
        nodes=(request.get('workflow') or {}).get('nodes',[])
        expected={_engine_task_id(job_id,n['id']) for n in nodes}
        if not isinstance(stop_proof,dict):raise DomainError(409,'缺少中心引擎停止证明')
        created=stop_proof.get('created_task_ids');never=stop_proof.get('never_created_task_ids')
        if (stop_proof.get('job_id')!=job_id or stop_proof.get('terminal') is not True or stop_proof.get('completed') is not True
                or not isinstance(created,list) or not isinstance(never,list)
                or not all(isinstance(t,str) for t in created+never)
                or set(created)&set(never) or len(created)!=len(set(created)) or len(never)!=len(set(never))
                or set(created)|set(never)!=expected):raise DomainError(409,'中心引擎停止证明范围不匹配')
        local_tasks=sorted(_engine_task_id(job_id,n['id']) for n in nodes if any((p.get('connector_id') or p.get('domain_id'))==connector_id for p in n.get('parties',[])))
        local_stop=await client.task_quiescence(local_tasks) if local_tasks else {'ready':True,'task_ids':[]}
        if local_stop.get('ready') is not True or local_stop.get('task_ids')!=local_tasks:raise DomainError(409,'本域仍有任务或容器未确认停止')
    artifacts=[a for a in request.get('artifact_plan',[]) if a['connector_id']==connector_id]
    receipts=[]
    for a in artifacts:
        path=owned_path(a['relative_uri'],project_id,run_id)
        if phase=='verify':
            content,_=await client.download_file(path)
            receipts.append({'path':path,'size':len(content),'sha256':hashlib.sha256(content).hexdigest(),'retention':a['retention']})
        elif phase=='cleanup' and a['retention']=='temporary':
            try:await client.delete_file(path)
            except KusciaError as exc:
                if not any(s in str(exc).lower() for s in ('not found','not exist')):raise
            receipts.append({'path':path,'state':'deleted'})
    if phase=='cleanup' and extraction:
        for task_id in sorted(t for t in task_ids if t):
            task=extraction.task(task_id,connector_id)
            if task.get('state')=='cleaned':continue
            if task.get('state') not in {'ready','failed','cancelled','awaiting-upload'}:
                # DI cancellation must be confirmed before removing its FTP session.
                await extraction.cancel(task_id,connector_id,profile)
            await extraction.cleanup(task_id,connector_id,profile,release=True,release_proof=stop_proof)
    state='verified' if phase=='verify' else 'cleaned'
    value={'run_id':run_id,'connector_id':connector_id,'state':state,'receipts':receipts}
    if local_stop is not None:value['stop_receipt']=local_stop
    executions.db.durable_write('run_artifacts',run_id+':'+connector_id,value,state)
    return value
