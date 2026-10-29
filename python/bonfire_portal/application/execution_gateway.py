from __future__ import annotations

"""Connector execution-gateway orchestration.

This use case coordinates the platform, the peer Connector and the local
privacy-compute adapter. It contains no FastAPI request objects.
"""

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from ..config import Settings
from ..domain.errors import DomainError
from ..infrastructure.database import Database
from ..infrastructure.kuscia import LiteClient
from ..infrastructure.platform import PlatformClient
from ..infrastructure.state import PortalState
from .execution import ExecutionService


@dataclass(frozen=True, slots=True)
class ExecutionGatewayContext:
    connector_id: str
    authorization: str | None = None
    machine_dispatch: bool = False
    machine_signer: str = ""


class ExecutionGatewayService:
    def __init__(self, settings: Settings, database: Database, state: PortalState,
                 executions: ExecutionService):
        self.settings, self.database, self.state = settings, database, state
        self.executions = executions

    async def requests(self, context: ExecutionGatewayContext) -> Any:
        return await PlatformClient(self.settings, context.authorization).request(
            "GET", "/privacy-computing/gateway/requests",
            params={"connector_id": context.connector_id},
        )

    def _profile(self, context: ExecutionGatewayContext) -> dict[str, Any]:
        profile = self.state.profile(context.connector_id)
        if not profile:
            raise DomainError(404 if context.machine_dispatch else 409, "本地连接器配置不存在")
        return profile

    async def _request(self, context: ExecutionGatewayContext, run_id: str,
                       body: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        profile = self._profile(context)
        if context.machine_dispatch:
            return profile, body.get("execution_request") or {}
        remote = await PlatformClient(self.settings, context.authorization).execution_run(
            run_id, context.connector_id
        )
        # User-supplied snapshots must never mint a platform auto-authorization.
        return profile, remote or {}

    async def identity(self, context: ExecutionGatewayContext, _run_id: str) -> dict[str, Any]:
        profile = self._profile(context)
        domain = str(profile.get("domain_id") or "")
        if not domain or not profile.get("lite_kuscia_endpoint") or not profile.get("lite_cert_dir"):
            raise DomainError(409, "本地隐私计算引擎尚未完成接入")
        value = await LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"]).query_domain(domain)
        return {"connector_id": context.connector_id, "domain_id": domain,
                "cert": (value.get("data") or {}).get("cert")}

    async def _ensure_counterparty_route(self, context: ExecutionGatewayContext,
                                         profile: dict[str, Any], request: dict[str, Any],
                                         identity: dict[str, Any]) -> dict[str, Any]:
        own_provider = request.get("provider_connector_id") == context.connector_id
        peer_id = str(request.get(
            "consumer_connector_id" if own_provider else "provider_connector_id"
        ) or "")
        gateway = str(request.get(
            "consumer_gateway_endpoint" if own_provider else "provider_gateway_endpoint"
        ) or "")
        if not peer_id or not gateway:
            raise DomainError(422, "执行请求缺少对端 Connector 或 Kuscia 网关信息")
        if str(identity.get("connector_id") or "") != peer_id:
            raise DomainError(409, "中心下发的对端引擎身份与执行参与方不一致")
        peer_domain = str(identity.get("domain_id") or "")
        peer_cert = str(identity.get("cert") or "")
        if not peer_domain or not peer_cert:
            raise DomainError(422, "对端节点身份或 Domain 证书不完整")
        parsed = urlparse(gateway if "://" in gateway else "http://" + gateway)
        if not parsed.hostname:
            raise DomainError(422, "对端 Kuscia 网关地址无效")
        engine = LiteClient(profile["lite_kuscia_endpoint"], profile["lite_cert_dir"])
        await engine.ensure_partner_domain(peer_domain, peer_cert, allow_certificate_update=True)
        await engine.create_route(
            str(profile.get("domain_id") or ""), peer_domain, str(parsed.hostname),
            int(parsed.port or (443 if parsed.scheme == "https" else 80)), parsed.scheme == "https",
        )
        self.database.durable_write("route", f"{context.connector_id}:{peer_domain}", {
            "source": str(profile.get("domain_id") or ""),
            "destination": peer_domain,
            "local_connector_id": context.connector_id,
            "connector_id": peer_id,
            "gateway_endpoint": gateway,
        }, "ready")
        return {"connector_id": peer_id, "domain_id": peer_domain, "cert": peer_cert}

    async def prepare(self, context: ExecutionGatewayContext, run_id: str,
                      body: dict[str, Any]) -> dict[str, Any]:
        profile, request = await self._request(context, run_id, body)
        if request.get("scheduling_mode") != "master-lite":
            peer_identity = body.get("peer_identity")
            if not isinstance(peer_identity, dict):
                raise DomainError(422, "中心调度请求缺少对端引擎身份")
            await self._ensure_counterparty_route(context, profile, request, peer_identity)
        record = await self.executions.execute(
            run_id, context.connector_id, request, profile, self.database,
            prepare_only=True,
        )
        prepared = record.get("prepared_bundle") or record.get("prepared_manifest")
        if not prepared:
            raise DomainError(502, "本地输入接入完成但未生成可验证清单")
        return prepared

    async def execute(self, context: ExecutionGatewayContext, run_id: str,
                      body: dict[str, Any]) -> dict[str, Any]:
        profile, request = await self._request(context, run_id, body)
        if request.get("scheduling_mode") == "master-lite" or profile.get("scheduling_mode") == "master-lite":
            raise DomainError(409, "计算作业由中心 Kuscia Master 提交，Lite 不承担调度")
        if request.get("dispatch_connector_id") != context.connector_id:
            raise DomainError(403, "只有中心指定的调度连接器可以提交计算作业")
        peer_prepared = body.get("peer_prepared")
        if not isinstance(peer_prepared, dict):
            raise DomainError(422, "中心调度请求缺少对端输入清单")
        result = await self.executions.execute(
            run_id, context.connector_id, request, profile, self.database, peer_prepared
        )
        report = {"connector_id": context.connector_id, "status": result.get("status"),
                  "external_run_ref": result.get("external_run_ref")}
        try:
            if context.machine_dispatch:
                await PlatformClient(self.settings, None).machine_report_execution(run_id, profile, report)
            else:
                await PlatformClient(self.settings, context.authorization).report_execution(run_id, report)
        except Exception:
            # Durable recovery reports the authoritative state after submission.
            pass
        return result

    async def sync(self, context: ExecutionGatewayContext, run_id: str) -> dict[str, Any]:
        profile = self._profile(context)
        result = await self.executions.sync(run_id, context.connector_id, profile)
        report = {"connector_id": context.connector_id, "status": result.get("status"),
                  "external_run_ref": result.get("external_run_ref")}
        if result.get("status") == "succeeded":
            report["result"] = {
                "outputs": result.get("outputs") or {}, "output_ref": result.get("output_ref"),
                "output_uri": result.get("output_uri"), "output_format": result.get("output_format"),
            }
        elif result.get("status") in {"failed", "cancelled"}:
            status = result.get("kuscia_status") or {}
            report["error"] = str(status.get("message") or status.get("reason") or result.get("status"))[:1000]
        if context.machine_dispatch:
            await PlatformClient(self.settings, None).machine_report_execution(run_id, profile, report)
        else:
            await PlatformClient(self.settings, context.authorization).report_execution(run_id, report)
        return {"run_id": run_id, **{key: value for key, value in report.items() if key != "connector_id"},
                "kuscia_status": result.get("kuscia_status")}

    async def report(self, context: ExecutionGatewayContext, run_id: str,
                     body: dict[str, Any]) -> Any:
        status = str(body.get("status") or "")
        if status not in {"accepted", "running", "succeeded", "failed", "cancelled"}:
            raise DomainError(422, "无效的执行状态")
        payload = {"connector_id": context.connector_id, **body}
        if context.machine_dispatch:
            profile = self._profile(context)
            return await PlatformClient(self.settings, None).machine_report_execution(
                run_id, profile, payload
            )
        return await PlatformClient(self.settings, context.authorization).report_execution(run_id, payload)
