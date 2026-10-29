from __future__ import annotations

"""Privacy-compute engine integration use cases."""

import base64
import os
import shlex
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

from ..config import Settings
from ..domain.errors import DomainError
from ..infrastructure.kuscia import KusciaError, LiteClient
from ..infrastructure.platform import PlatformClient
from ..infrastructure.state import PortalState


CAPABILITY_CODE = "privacy-compute.appimage"


class PrivacyComputeService:
    def __init__(self, settings: Settings, state: PortalState):
        self.settings, self.state = settings, state

    async def state_view(self, connector_id: str, domain: str, endpoint: str, cert_dir: str,
                         profile: dict[str, Any] | None) -> dict[str, Any]:
        result = {
            "connector_id": connector_id or None,
            "configured": bool(domain),
            "status": "not_configured" if not domain else "unavailable",
            "engine_type": "kuscia" if domain else None,
            "implementation_ref": domain or None,
            "control_endpoint": endpoint or None,
            "gateway_endpoint": (profile or {}).get("gateway_endpoint"),
            "portal_browser_url": (profile or {}).get("portal_browser_url"),
            "engine_datasource_ref": (profile or {}).get("engine_datasource_ref"),
            "capabilities": [],
        }
        if domain and endpoint:
            try:
                info = await LiteClient(endpoint, cert_dir).query_domain(domain)
                result.update({"status": "available", "node": info.get("data"),
                               "capabilities": [CAPABILITY_CODE]})
            except (KusciaError, OSError) as exc:
                result["reason"] = str(exc)
        return result

    async def provision(self, connector_id: str, implementation_ref: str | None,
                        authorization: str | None) -> dict[str, Any]:
        result = await PlatformClient(self.settings, authorization).provision_privacy_compute(
            connector_id, implementation_ref
        )
        return {**(result or {}),
                "engine_datasource_ref": f"bonfire-staging-{connector_id.replace('-', '')[:16]}"}

    def deploy_script(self, body: dict[str, Any]) -> dict[str, Any]:
        required = ["implementation_ref", "gateway_endpoint", "engine_image", "master_endpoint", "deploy_token"]
        missing = [key for key in required if not body.get(key)]
        if missing:
            raise DomainError(422, f"缺少 {missing[0]}")
        try:
            ports = {
                "gateway": int(body.get("gateway_port", 28080)),
                "api": int(body.get("api_port", 28081)),
                "grpc": int(body.get("grpc_port", 28082)),
                "internal": int(body.get("internal_port", 28083)),
                "metrics": int(body.get("metrics_port", 28084)),
            }
        except (TypeError, ValueError) as exc:
            raise DomainError(422, "引擎端口必须是整数") from exc
        if len(set(ports.values())) != 5 or any(port < 1 or port > 65535 for port in ports.values()):
            raise DomainError(422, "五个引擎端口必须有效且互不重复")
        image = str(body["engine_image"])
        domain = str(body["implementation_ref"])
        gateway = str(body["gateway_endpoint"])
        config_name, cert_name = f"lite_{domain}.yaml", f"{domain}-certs"
        lines = [
            "#!/usr/bin/env bash", "set -euo pipefail",
            f"export KUSCIA_IMAGE={shlex.quote(image)}",
            'docker pull "$KUSCIA_IMAGE"',
            'docker run --rm "$KUSCIA_IMAGE" cat /home/kuscia/scripts/deploy/kuscia.sh > kuscia.sh',
            "chmod u+x kuscia.sh",
            f'docker run --rm "$KUSCIA_IMAGE" kuscia init --mode lite --domain {shlex.quote(domain)} --master-endpoint {shlex.quote(str(body["master_endpoint"]))} --lite-deploy-token {shlex.quote(str(body["deploy_token"]))} --runtime runc > {shlex.quote(config_name)}',
            f"./kuscia.sh start -c {shlex.quote(config_name)} -p {ports['gateway']} -k {ports['api']} -g {ports['grpc']} -q {ports['internal']} -x {ports['metrics']} -a secretflow",
            f"mkdir -p {shlex.quote(cert_name)}",
            f'docker cp "$(docker ps -qf name={domain} | head -n1)":/home/kuscia/var/certs/. {shlex.quote(cert_name + "/")}',
            f"# 本地控制 API: https://host.docker.internal:{ports['api']}",
            f"# Lite 网关: {gateway}",
            "# 私有镜像仓库或代理环境请在接入前运行适用于 Lite 节点的 registry/proxy 配置脚本。",
        ]
        return {"domain_id": domain, "commands": "\n".join(lines), "ports": ports,
                "mode": "master-lite", "node_type": "lite", "runtime": "runc"}

    async def activate(self, connector_id: str, body: dict[str, Any],
                       authorization: str | None) -> dict[str, Any]:
        domain = str(body.get("implementation_ref") or "")
        advertised = str(body.get("control_endpoint") or "")
        gateway = str(body.get("gateway_endpoint") or "")
        portal = str(body.get("portal_endpoint") or "")
        browser_url = str(body.get("portal_browser_url") or "").strip().rstrip("/")
        if browser_url:
            browser = urlparse(browser_url)
            if browser.scheme not in {"http", "https"} or not browser.hostname or browser.username or browser.password or browser.query or browser.fragment:
                raise DomainError(422, "Portal 浏览器地址必须是无凭据、无查询参数的 HTTP(S) 地址")
        endpoint = advertised
        storage = str(body.get("engine_datasource_ref") or
                      f"bonfire-staging-{connector_id.replace('-', '')[:16]}")
        if not domain or not endpoint or not gateway or not portal:
            raise DomainError(422, "缺少引擎实现引用、控制地址、P2P 网关或连接器服务地址")
        parsed = urlparse(endpoint)
        if parsed.hostname in {"127.0.0.1", "localhost"} and os.getenv("PORTAL_CONTAINER_HOST"):
            host = os.getenv("PORTAL_CONTAINER_HOST", "host.docker.internal")
            endpoint = urlunparse(parsed._replace(
                netloc=host + (f":{parsed.port}" if parsed.port else "")
            )).rstrip("/")
        cert_dir = self.settings.portal_data_dir / "lite" / domain / "certs"
        cert_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name, value in (body.get("files") or {}).items():
            safe = Path(str(name)).name
            if safe in {"", ".", ".."}:
                continue
            try:
                content = base64.b64decode(value, validate=True)
            except (ValueError, TypeError) as exc:
                raise DomainError(422, f"引擎证书文件 {safe} 不是有效 Base64") from exc
            target = cert_dir / safe
            target.write_bytes(content)
            target.chmod(0o600 if safe.endswith(".key") or safe == "token" else 0o644)
        try:
            client = LiteClient(endpoint, str(cert_dir))
            await client.query_domain(domain)
            try:
                await client.create_domain_datasource(domain, storage, "/home/kuscia/var/storage/data")
            except KusciaError as exc:
                if "exist" not in str(exc).lower():
                    raise
        except (KusciaError, OSError) as exc:
            raise DomainError(502, f"Kuscia Lite 不可达: {exc}") from exc
        platform = PlatformClient(self.settings, authorization)
        user = await platform.me()
        username = str((user or {}).get("username") or "")
        if not username:
            raise DomainError(401, "无法识别当前用户")
        current = self.state.selected(username) or {"connector_id": connector_id}
        profile = {
            **current, "connector_id": connector_id, "domain_id": domain,
            "lite_kuscia_endpoint": endpoint, "lite_cert_dir": str(cert_dir),
            "engine_datasource_ref": storage, "gateway_endpoint": gateway,
            "portal_endpoint": portal, "portal_browser_url": browser_url, "scheduling_mode": "master-lite",
            "ftp_host": body.get("ftp_host") or self.settings.engine_upload_host,
            "ftp_port": body.get("ftp_port") or self.settings.engine_upload_port,
        }
        self.state.save_profile(username, profile)
        await platform.declare_capability(connector_id, {
            "capability_code": CAPABILITY_CODE, "capability_version": "1.0.0",
            "adapter_type": "kuscia", "implementation_ref": domain,
            "evidence": {
                "local_probe": {"available": True, "source": "connector-portal"},
                "network": {
                    "connector_endpoint": portal, "execution_endpoint": advertised,
                    "gateway_endpoint": gateway, "execution_node_ref": domain,
                    "execution_storage_ref": storage,
                    "portal_browser_url": browser_url,
                },
            },
        })
        verification = await platform.verify_capability(connector_id, CAPABILITY_CODE)
        if not (verification or {}).get("available"):
            raise DomainError(502, str((verification or {}).get("reason") or "中心未通过隐私计算引擎能力验证"))
        return {
            "connector_id": connector_id, "configured": True, "status": "available",
            "engine_type": "kuscia", "implementation_ref": domain,
            "engine_datasource_ref": storage, "capabilities": [CAPABILITY_CODE],
        }
