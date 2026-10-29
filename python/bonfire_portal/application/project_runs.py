"""Read-only project workspace scoped by center-authorized connector tasks."""
import re
from ..domain.errors import DomainError
from ..infrastructure.platform import PlatformClient


def task_log_matches(file, task_id):
    if not task_id or file.get('kind') != 'pod': return False
    pod = file.get('pod') or {}
    text = str(pod.get('pod_name') or file.get('name') or '')
    return bool(re.search(r'(?<![a-z0-9])' + re.escape(task_id) + r'(?=$|[-_/.])', text))


class ProjectRunsService:
    def __init__(self, settings, operations):
        self.settings, self.operations = settings, operations

    async def runs(self, connector_id, authorization, offset=0):
        return await PlatformClient(self.settings,authorization).request('GET','/projects/results/local',params={'connector_id':connector_id,'offset':offset})

    async def resolve(self, connector_id, authorization, execution_id):
        return await PlatformClient(self.settings,authorization).request('POST','/projects/results/resolve',{'connector_id':connector_id,'execution_id':execution_id})

    async def detail(self, connector_id, authorization, run_id):
        return await PlatformClient(self.settings,authorization).request('GET','/projects/results/local/'+run_id,params={'connector_id':connector_id})

    async def logs(self, connector_id, authorization, run_id, task_id):
        run=await self.detail(connector_id,authorization,run_id)
        if task_id not in {t['task_id'] for t in run['tasks']} or not task_id:
            raise DomainError(403,'该任务不属于本连接器的当前执行批次')
        files=await self.operations.log_files(connector_id,'pod')
        return [f for f in files.get('files',[]) if task_log_matches(f,task_id)]

    async def tail(self, connector_id, authorization, run_id, task_id, path, lines=200):
        files=await self.logs(connector_id,authorization,run_id,task_id)
        if path not in {f['path'] for f in files}:raise DomainError(403,'日志不属于所选任务')
        return await self.operations.log_tail(connector_id,path,min(max(lines,1),2000),None)

    async def download(self, connector_id, authorization, run_id, path):
        run=await self.detail(connector_id,authorization,run_id)
        if path not in {o['path'] for o in run['outputs']}:raise DomainError(403,'文件不属于本连接器的正式结果')
        return self.operations.create_download_ticket(connector_id,path)
