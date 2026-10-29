from __future__ import annotations

"""Connector identity onboarding use cases.

The connector private key never leaves local state. This service owns the
identity lifecycle; HTTP adapters only translate transport values.
"""

import base64
import os
from pathlib import Path
from typing import Any, Callable

from ..config import Settings
from ..domain.errors import DomainError
from ..infrastructure.database import Database
from ..infrastructure.identity import (
    ensure_identity,
    install_certificate,
    validate_issued_certificate,
)
from ..infrastructure.kuscia import KusciaError, LiteClient
from ..infrastructure.platform import PlatformClient
from ..infrastructure.state import PortalState


class OnboardingService:
    def __init__(self, settings: Settings, database: Database, state: PortalState,
                 endpoint_with_port: Callable[[str, Any], str]):
        self.settings, self.database, self.state = settings, database, state
        self.endpoint_with_port = endpoint_with_port

    async def state_view(self, authorization: str | None, configured_connector_id: str = "") -> dict[str, Any]:
        env_onboarded = bool(configured_connector_id)
        if not authorization:
            return {"onboarded": bool(self.state.has_any_profile() or env_onboarded)}
        username = await self._username(authorization)
        profile = self.state.selected(username)
        return {
            "onboarded": bool(profile),
            "domain_id": profile.get("domain_id") if profile else None,
            "connector_id": profile.get("connector_id") if profile else None,
            "pending": self.state.pending(username),
            "connectors": self.state.profiles(username),
            "access_denied": bool(env_onboarded and not profile),
        }

    async def connectors(self, authorization: str | None) -> Any:
        return await PlatformClient(self.settings, authorization).list_connectors()

    async def identity(self, authorization: str | None) -> dict[str, Any]:
        return ensure_identity(self.settings.portal_data_dir, await self._username(authorization))

    async def register(self, body: dict[str, Any], authorization: str | None) -> dict[str, Any]:
        platform = PlatformClient(self.settings, authorization)
        username = await self._username(authorization, platform)
        identity = ensure_identity(self.settings.portal_data_dir, username)
        connector = await platform.register_connector({
            "name": body.get("name"), "org_name": body.get("org_name"),
            "csr_pem": identity["csr_pem"],
        })
        self.state.save_pending(username, {
            "connector_id": connector.get("id"), "identity_dir": identity["identity_dir"],
            "owner_username": username,
        })
        return connector

    async def upload_certs(self, body: dict[str, Any], authorization: str | None) -> dict[str, Any]:
        connector_id = str(body.get("connector_id") or "")
        if not connector_id:
            raise DomainError(422, "缺少 connector_id")
        platform = PlatformClient(self.settings, authorization)
        current = await self._owned_connector(platform, connector_id)
        if str(current.get("status") or "") not in {"approved", "active", "online", "offline"}:
            raise DomainError(409, "连接器尚未审批通过，暂不能完成基础接入")
        username = await self._username(authorization, platform)
        pending = self.state.pending(username)
        domain = str((pending or {}).get("kuscia_domain_id") or os.getenv("PORTAL_DOMAIN_ID") or connector_id)
        cert_dir = self.settings.portal_data_dir / "lite" / domain / "certs"
        cert_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        saved: list[str] = []
        for name, encoded in (body.get("files") or {}).items():
            safe = Path(str(name)).name
            if safe in {"", ".", ".."}:
                continue
            try:
                content = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as exc:
                raise DomainError(422, f"证书文件 {safe} 不是有效 Base64") from exc
            target = cert_dir / safe
            target.write_bytes(content)
            target.chmod(0o600 if safe.endswith(".key") or safe == "token" else 0o644)
            saved.append(safe)
        return {"cert_dir": str(cert_dir), "saved": saved}

    async def discover(self, connector_id: str | None, endpoint: str,
                       authorization: str | None) -> dict[str, Any]:
        if not connector_id:
            raise DomainError(422, "缺少 connector_id")
        platform = PlatformClient(self.settings, authorization)
        current = await self._owned_connector(platform, connector_id)
        username = await self._username(authorization, platform)
        pending = self.state.pending(username) or {}
        domain = str(pending.get("kuscia_domain_id") or os.getenv("PORTAL_DOMAIN_ID") or connector_id)
        cert_dir = self.settings.portal_data_dir / "lite" / domain / "certs"
        required = {"ca.crt", "kusciaapi-server.crt", "kusciaapi-server.key", "token"}
        present = {path.name for path in cert_dir.iterdir()} if cert_dir.exists() else set()
        missing = sorted(required - present)
        resolved_endpoint = self.endpoint_with_port(
            endpoint or str(current.get("lite_api_endpoint") or ""), current.get("lite_api_port")
        )
        if not missing and resolved_endpoint:
            try:
                await LiteClient(resolved_endpoint, cert_dir).query_domain(domain)
            except (OSError, KusciaError) as exc:
                return {"detected": False, "domain_id": domain, "lite_endpoint": resolved_endpoint,
                        "cert_dir": str(cert_dir), "missing": [], "message": str(exc)}
        return {"detected": not missing, "domain_id": domain, "lite_endpoint": resolved_endpoint or None,
                "cert_dir": str(cert_dir), "missing": missing}

    async def finalize(self, body: dict[str, Any], authorization: str | None) -> dict[str, Any]:
        platform = PlatformClient(self.settings, authorization)
        connector_id = str(body.get("connector_id") or "")
        if not connector_id:
            raise DomainError(422, "缺少 connector_id")
        connector = await self._owned_connector(platform, connector_id)
        if str(connector.get("status") or "") not in {"approved", "active", "online", "offline"}:
            raise DomainError(409, "连接器尚未审批通过，暂不能完成基础接入")
        username = await self._username(authorization, platform)
        issued = await platform.get_connector_certificate(connector_id)
        certificate = str(issued.get("certificate_pem") or issued.get("certificate") or "")
        ca = str(issued.get("ca_certificate_pem") or issued.get("ca_certificate") or "")
        if not certificate or not ca:
            raise DomainError(502, "中心未返回完整连接器证书")
        fingerprint = str(issued.get("fingerprint") or issued.get("certificate_fingerprint") or "")
        if not fingerprint:
            raise DomainError(502, "中心未返回连接器证书指纹")
        identity = ensure_identity(self.settings.portal_data_dir, username)
        try:
            validate_issued_certificate(identity["identity_dir"], certificate, fingerprint)
        except (OSError, ValueError) as exc:
            raise DomainError(502, f"中心签发的连接器证书校验失败: {exc}") from exc
        identity_dir = install_certificate(self.settings.portal_data_dir, username, certificate, ca)
        await platform.activate_connector(connector_id, fingerprint)
        pending = self.state.pending(username) or {}
        previous = self.state.selected(username)
        domain = str(pending.get("kuscia_domain_id") or body.get("domain_id") or connector.get("kuscia_domain_id") or "")
        cert_dir = str(body.get("lite_cert_dir") or (self.settings.portal_data_dir / "lite" / domain / "certs"))
        endpoint = self.endpoint_with_port(str(body.get("lite_kuscia_endpoint") or
            pending.get("lite_kuscia_endpoint") or connector.get("lite_api_endpoint") or ""), connector.get("lite_api_port"))
        if domain and endpoint and (Path(cert_dir) / "token").exists():
            try:
                await LiteClient(endpoint, cert_dir).query_domain(domain)
            except (OSError, KusciaError) as exc:
                raise DomainError(502, f"Kuscia Lite 证书或地址校验失败: {exc}") from exc
        profile = {**(previous or {}), "connector_id": connector_id, "domain_id": domain,
                   "identity_dir": identity_dir, "lite_kuscia_endpoint": endpoint or None,
                   "lite_cert_dir": cert_dir if Path(cert_dir).exists() else None}
        old_id = str((previous or {}).get("connector_id") or "")
        owned = await platform.list_connectors()
        owned_ids = {str(item.get("id") or "") for item in owned if isinstance(item, dict)} if isinstance(owned, list) else set()
        if old_id and old_id != connector_id and old_id not in owned_ids:
            self.database.reassign_connector(old_id, connector_id)
            self.state.remove_profile(username, old_id)
        self.state.save_profile(username, profile)
        self.state.clear_pending(username)
        return {"onboarded": True, **profile, "identity_status": "active"}

    async def _username(self, authorization: str | None,
                        platform: PlatformClient | None = None) -> str:
        user = await (platform or PlatformClient(self.settings, authorization)).me()
        username = str((user or {}).get("username") or "")
        if not username:
            raise DomainError(401, "无法识别当前用户")
        return username

    @staticmethod
    async def _owned_connector(platform: PlatformClient, connector_id: str) -> dict[str, Any]:
        owned = await platform.list_connectors()
        current = next((item for item in owned if str(item.get("id") or "") == connector_id), None) if isinstance(owned, list) else None
        if not current:
            raise DomainError(403, "当前用户无权操作此连接器")
        return current
