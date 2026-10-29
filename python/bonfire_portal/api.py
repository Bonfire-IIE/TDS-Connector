from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, Query, Request, Depends

from .application.context import PortalContext
from .application.authentication import AuthenticationRequest, PortalAuthenticator
from .interfaces.http import (
    AppImageHttpAdapter, AuditHttpAdapter,
    MovementHttpAdapter, OnboardingHttpAdapter, OperationsHttpAdapter,
    PrivacyComputeHttpAdapter, PrivacyExecutionHttpAdapter, SessionHttpAdapter,
)
from .interfaces.http.node import NodeHttpAdapter
from .interfaces.http.delegations import DelegationHttpAdapter
from .config import Settings
from .domain.errors import DomainError
from .infrastructure.database import Database


def create_router(settings: Settings, database: Database, catalog=None,
                 context: PortalContext | None = None) -> APIRouter:
    # The HTTP adapter receives an application context from the composition
    # root.  The fallback preserves the small public factory used by tests and
    # older embedding code while keeping construction out of individual routes.
    context = context or PortalContext.build(settings, database, catalog)
    settings, database = context.settings, context.database
    state = context.state
    authenticator = PortalAuthenticator(settings, database, state)

    async def auth_guard(request: Request) -> None:
        result = await authenticator.authenticate(AuthenticationRequest(
            path=request.url.path,
            method=request.method,
            query=request.url.query,
            headers={key.lower(): value for key, value in request.headers.items()},
            body=await request.body() if "/execution-requests/" in request.url.path else b"",
            configured_connector_id=str(request.app.state.connector_id or ""),
        ))
        request.state.username = result.username
        if result.connector_id:
            request.state.connector_id = result.connector_id
        if request.url.path.startswith('/portal/extractions') and not result.machine_dispatch:
            identity = await context.services.json('di', result.connector_id, 'GET', '/api/v1/identity', username=result.username)
            role = 'transfer:read' if request.method == 'GET' else 'transfer:write'
            if role not in identity.get('roles', []): raise DomainError(403, 'permission_denied')
        if result.machine_dispatch:
            request.state.machine_dispatch = True
        if result.machine_signer is not None:
            request.state.machine_signer = result.machine_signer

    router = APIRouter(prefix="/portal", dependencies=[Depends(auth_guard)])
    appimages = context.appimages

    def profile_for(request: Request) -> dict[str, Any] | None:
        cid = str(getattr(request.state, "connector_id", None) or request.app.state.connector_id or "")
        return state.profile(cid) if cid else state.only_profile()

    def engine_config(request: Request) -> tuple[str, str, str, dict[str, Any] | None]:
        profile = profile_for(request)
        domain = str((profile or {}).get("domain_id") or os.getenv("PORTAL_DOMAIN_ID", ""))
        endpoint = str((profile or {}).get("lite_kuscia_endpoint") or os.getenv("LITE_KUSCIA_ENDPOINT", ""))
        cert_dir = str((profile or {}).get("lite_cert_dir") or os.getenv(
            "LITE_CERT_DIR", str(settings.portal_data_dir / "lite" / domain / "certs") if domain else ""
        ))
        return domain, endpoint, cert_dir, profile

    def connector_id(request: Request) -> str:
        value = getattr(request.state, "connector_id", None) or request.app.state.connector_id
        if not value:
            raise DomainError(401, "当前 Portal 未绑定连接器身份")
        return value

    def authorization(request: Request) -> str | None:
        return request.headers.get("authorization")

    onboarding_http = OnboardingHttpAdapter(context.onboarding)
    execution_http = PrivacyExecutionHttpAdapter(context.execution_gateway, connector_id, authorization)
    appimage_http = AppImageHttpAdapter(appimages, connector_id)
    node_http = NodeHttpAdapter(context.node_operations, connector_id)
    movement_http = MovementHttpAdapter(context.data_movement, connector_id)
    privacy_compute_http = PrivacyComputeHttpAdapter(context.privacy_compute, connector_id, authorization, engine_config)
    session_http = SessionHttpAdapter(context.sessions)
    audit_http = AuditHttpAdapter(context.audits, connector_id, authorization)
    operations_http = OperationsHttpAdapter(context.operations, connector_id, authorization)
    delegations_http = DelegationHttpAdapter(settings, connector_id, authorization, database)



    @router.post("/login")
    async def login(request: Request):
        return {"code": 0, "message": "ok", "data": await session_http.login(await request.json())}

    @router.get("/status")
    async def status(request: Request):
        return {"code": 0, "message": "ok", "data": session_http.status(request)}

    @router.get("/onboarding/state")
    async def onboarding_state(request: Request):
        return {"code": 0, "message": "ok", "data": await onboarding_http.state_view(request, authorization(request))}

    @router.get("/onboarding/connectors")
    async def onboarding_connectors(request: Request):
        return {"code": 0, "message": "ok", "data": await onboarding_http.connectors(authorization(request))}

    @router.post("/onboarding/identity")
    async def onboarding_identity(request: Request):
        return {"code": 0, "message": "ok", "data": await onboarding_http.identity(authorization(request))}

    @router.post("/onboarding/register")
    async def onboarding_register(request: Request):
        return {"code": 0, "message": "ok", "data": await onboarding_http.register(
            await request.json(), authorization(request))}

    @router.get("/onboarding/deploy-script")
    async def onboarding_deploy_script():
        raise DomainError(410, "连接器身份接入不部署计算引擎；请进入隐私保护计算使用 P2P 部署向导")

    @router.post("/onboarding/upload-certs")
    async def onboarding_upload_certs(request: Request):
        return {"code": 0, "message": "ok", "data": await onboarding_http.upload_certs(
            await request.json(), authorization(request))}

    @router.get("/onboarding/discover")
    async def onboarding_discover(request: Request, connector_id: str | None = None):
        return {"code": 0, "message": "ok", "data": await onboarding_http.discover(
            request, connector_id, authorization(request))}

    @router.post("/onboarding/finalize")
    async def onboarding_finalize(request: Request):
        return {"code": 0, "message": "ok", "data": await onboarding_http.finalize(
            await request.json(), authorization(request))}




    @router.get("/overview")
    async def overview(request: Request):
        return {"code": 0, "message": "ok", "data": await operations_http.overview(request)}

    @router.get("/routes")
    async def list_routes(request: Request):
        return {"code": 0, "message": "ok", "data": await operations_http.routes(request)}

    @router.delete("/routes/{destination}")
    async def delete_route(destination: str, request: Request):
        return {"code": 0, "message": "ok", "data": {"deleted": await operations_http.delete_route(request, destination)}}

    @router.get("/computation-delegations")
    async def computation_delegations(request: Request):
        return {"code": 0, "message": "ok", "data": await delegations_http.inbox(request)}

    @router.post("/computation-delegations/{delegation_id}/decision")
    async def computation_delegation_decision(delegation_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await delegations_http.decision(request, delegation_id)}

    @router.get("/projects")
    async def list_projects(request: Request):
        return {"code": 0, "message": "ok", "data": await operations_http.projects(request)}

    @router.get("/projects/{project_id}")
    async def get_project(project_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await operations_http.project(request, project_id)}

    @router.get("/jobs/{job_id}/log")
    async def get_job_log(job_id: str, request: Request, task_id: str | None = None):
        return {"code": 0, "message": "ok", "data": await operations_http.job_log(request, job_id, task_id)}

    @router.get("/integrations/privacy-compute/state")
    async def privacy_compute_state(request: Request):
        return {"code": 0, "message": "ok", "data": await privacy_compute_http.state_view(request)}

    @router.post("/integrations/privacy-compute/provision")
    async def provision_privacy_compute(request: Request):
        return {"code": 0, "message": "ok", "data": await privacy_compute_http.provision(request)}

    @router.post("/integrations/privacy-compute/deploy-script")
    async def deploy_privacy_compute(request: Request):
        return {"code": 0, "message": "ok", "data": await privacy_compute_http.deploy_script(request)}

    @router.post("/integrations/privacy-compute/activate")
    async def activate_privacy_compute(request: Request):
        return {"code": 0, "message": "ok", "data": await privacy_compute_http.activate(request)}

    @router.get("/files/status")
    async def files_status(request: Request):
        return {"code": 0, "message": "ok", "data": await node_http.status(request)}

    @router.get("/files")
    async def files(request: Request, path: str = ""):
        return {"code": 0, "message": "ok", "data": await node_http.files(request, path)}

    @router.put("/files")
    async def upload_file(request: Request, path: str = "", filename: str | None = None):
        return {"code": 0, "message": "ok", "data": await node_http.upload(request, path, filename)}

    @router.post("/files/mkdir")
    async def mkdir_file(request: Request):
        return {"code": 0, "message": "ok", "data": await node_http.mkdir(request, await request.json())}

    @router.post("/files/delete")
    async def delete_file(request: Request):
        return {"code": 0, "message": "ok", "data": {"deleted": await node_http.delete(request, await request.json())}}

    @router.post("/files/rename")
    async def rename_file(request: Request):
        return {"code": 0, "message": "ok", "data": await node_http.rename(request, await request.json())}

    @router.post("/files/download-ticket")
    async def download_ticket(request: Request):
        return {"code": 0, "message": "ok", "data": await node_http.ticket(request, await request.json())}

    @router.get("/files/download")
    async def download_file(ticket: str):
        return await node_http.download(ticket)

    @router.get("/logs/files")
    async def log_files(request: Request):
        return {"code": 0, "message": "ok", "data": await node_http.log_files(request)}

    @router.get("/logs/tail")
    async def log_tail(request: Request, path: str, lines: int = 500, keyword: str | None = None):
        return {"code": 0, "message": "ok", "data": await node_http.log_tail(request, path, lines, keyword)}

    @router.get("/logs/download")
    async def log_download(request: Request, path: str, lines: int = 10000):
        return await node_http.log_download(request, path, lines)

    @router.get("/logs/stream")
    async def log_stream(request: Request, path: str, lines: int = 200, keyword: str | None = None):
        return await node_http.log_stream(request, path, lines, keyword)

    @router.get("/audit/mirror")
    async def audit_mirror(request: Request):
        return {"code": 0, "message": "ok", "data": audit_http.mirror(request)}

    @router.post("/audit/sync")
    async def audit_sync(request: Request):
        return {"code": 0, "message": "ok", "data": await audit_http.sync(request)}

    from .application.project_runs import ProjectRunsService
    project_runs = ProjectRunsService(settings, context.node_operations)

    @router.get('/project-runs')
    async def local_project_runs(request:Request,offset:int=0):
        return {'code':0,'data':await project_runs.runs(connector_id(request),authorization(request),offset)}

    @router.post('/project-runs/resolve')
    async def resolve_project_run(request:Request):
        body=await request.json()
        return {'code':0,'data':await project_runs.resolve(connector_id(request),authorization(request),str(body.get('execution_id') or '').strip())}

    @router.get('/project-runs/{run_id}')
    async def local_project_run(run_id:str,request:Request):
        return {'code':0,'data':await project_runs.detail(connector_id(request),authorization(request),run_id)}

    @router.get('/project-runs/{run_id}/logs')
    async def project_logs(run_id:str,task_id:str,request:Request):
        return {'code':0,'data':await project_runs.logs(connector_id(request),authorization(request),run_id,task_id)}

    @router.post('/project-runs/{run_id}/logs/tail')
    async def project_log_tail(run_id:str,request:Request):
        body=await request.json()
        return {'code':0,'data':await project_runs.tail(connector_id(request),authorization(request),run_id,str(body.get('task_id') or ''),str(body.get('path') or ''),int(body.get('lines') or 200))}

    @router.post('/project-runs/{run_id}/download-ticket')
    async def project_download(run_id:str,request:Request):
        body=await request.json()
        return {'code':0,'data':await project_runs.download(connector_id(request),authorization(request),run_id,str(body.get('path') or ''))}

    @router.get("/integrations/privacy-compute/execution-requests")
    async def privacy_execution_requests(request: Request):
        return {"code": 0, "message": "ok", "data": await execution_http.requests(request)}

    @router.post("/integrations/privacy-compute/execution-requests/{run_id}/identity")
    async def execution_identity(run_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await execution_http.identity(request, run_id)}

    @router.post("/integrations/privacy-compute/execution-requests/{run_id}/connectivity")
    async def execution_connectivity(run_id: str, request: Request):
        if not getattr(request.state,"machine_dispatch",False) or getattr(request.state,"machine_signer","") != "@center":
            raise DomainError(403,"互联探测仅接受中心签名请求")
        from .application.connectivity import probe_connectivity
        return {"code":0,"message":"ok","data":await probe_connectivity(database,connector_id(request),profile_for(request),await request.json())}

    @router.post("/integrations/privacy-compute/execution-requests/{run_id}/prepare")
    async def execution_prepare(run_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await execution_http.prepare(request, run_id)}

    @router.post("/integrations/privacy-compute/execution-requests/{run_id}/execute")
    async def execution_execute(run_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await execution_http.execute(request, run_id)}

    @router.post("/integrations/privacy-compute/execution-requests/{run_id}/sync")
    async def execution_sync(run_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await execution_http.sync(request, run_id)}

    @router.post("/integrations/privacy-compute/execution-requests/{run_id}/artifacts")
    async def execution_artifacts(run_id: str, request: Request):
        if not getattr(request.state,"machine_dispatch",False):raise DomainError(403,"产物回收仅接受中心签名请求")
        body=await request.json();phase=body.get("phase")
        if phase not in {"scope","verify","cleanup"}:raise DomainError(422,"无效产物操作")
        if phase=="cleanup" and body.get("tasks_stopped") is not True:raise DomainError(409,"任务尚未确认停止")
        from .application.run_artifacts import reconcile_artifacts
        profile=profile_for(request)
        value=await reconcile_artifacts(context.executions,context.extractions,run_id,connector_id(request),profile,phase,body.get('stop_proof'))
        return {"code":0,"message":"ok","data":value}

    @router.post("/integrations/privacy-compute/execution-requests/{run_id}/report")
    async def execution_report(run_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await execution_http.report(request, run_id)}

    @router.post("/integrations/privacy-compute/appimages/register", status_code=201)
    async def register_appimage(request: Request):
        return {"code": 0, "message": "ok", "data": await appimage_http.register(request)}

    @router.get("/integrations/privacy-compute/appimages")
    async def list_appimages(request: Request):
        return {"code": 0, "message": "ok", "data": appimage_http.list(request)}






    @router.get("/extractions/options")
    async def extraction_options(request: Request):
        return {"code": 0, "message": "ok", "data": await movement_http.extraction_options(request)}

    @router.post("/extractions/prepare")
    async def prepare_extraction(request: Request):
        return {"code": 0, "message": "ok", "data": await movement_http.prepare_extraction(request)}



    @router.post("/extractions/run", status_code=202)
    async def run_extraction(request: Request):
        return {"code": 0, "message": "ok", "data": await movement_http.run_extraction(request)}

    @router.get("/extractions")
    async def list_extractions(request: Request):
        return {"code": 0, "message": "ok", "data": movement_http.list_extractions(request)}

    @router.get("/extractions/{extraction_id}")
    async def get_extraction(extraction_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": movement_http.get_extraction(request, extraction_id)}

    @router.post("/extractions/{extraction_id}/credentials")
    async def extraction_credentials(extraction_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await movement_http.extraction_action(request, extraction_id, "credentials")}

    @router.get("/extractions/{extraction_id}/received")
    async def extraction_received(extraction_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await movement_http.extraction_action(request, extraction_id, "received")}

    @router.post("/extractions/{extraction_id}/cancel")
    async def cancel_extraction(extraction_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await movement_http.extraction_action(request, extraction_id, "cancel")}

    @router.post("/extractions/{extraction_id}/complete", status_code=202)
    async def complete_extraction(extraction_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await movement_http.complete_extraction(request, extraction_id)}

    @router.post("/extractions/{extraction_id}/cleanup")
    async def cleanup_extraction(extraction_id: str, request: Request):
        return {"code": 0, "message": "ok", "data": await movement_http.extraction_action(request, extraction_id, "cleanup")}
























    # Compatibility aliases for the current React client.


    from .interfaces.http.services import install
    install(router, context.services, connector_id)
    return router


def _public_datasource(source: dict[str, Any]) -> dict[str, Any]:
    """Return metadata useful for diagnostics without ever returning credentials."""
    secret_words = {"password", "secret", "secret_key", "access_key", "access_key_id", "token", "private_key", "authorization"}
    def clean(value: Any, key: str = "") -> Any:
        if key.lower() in secret_words or any(word in key.lower() for word in ("password", "secret", "token")):
            return "[REDACTED]"
        if isinstance(value, dict):
            return {str(k): clean(v, str(k)) for k, v in value.items()}
        if isinstance(value, list):
            return [clean(v, key) for v in value]
        return value
    return clean(source)
