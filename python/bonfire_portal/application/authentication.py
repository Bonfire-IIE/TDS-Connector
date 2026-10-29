from __future__ import annotations

"""Authentication policy for browser and machine Portal requests."""

import hmac
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from ..config import Settings
from ..domain.errors import DomainError
from ..infrastructure.database import Database
from ..infrastructure.execution_auth import verify_execution_signature
from ..infrastructure.platform import PlatformClient
from ..infrastructure.state import PortalState


@dataclass(frozen=True, slots=True)
class AuthenticationRequest:
    path: str
    method: str
    query: str
    headers: Mapping[str, str]
    body: bytes
    configured_connector_id: str = ""


@dataclass(frozen=True, slots=True)
class AuthenticationResult:
    connector_id: str | None = None
    machine_dispatch: bool = False
    machine_signer: str | None = None
    username: str | None = None


class PortalAuthenticator:
    """Authenticate browser or machine commands without HTTP framework coupling."""

    def __init__(self, settings: Settings, database: Database, state: PortalState):
        self.settings, self.database, self.state = settings, database, state

    async def authenticate(self, request: AuthenticationRequest) -> AuthenticationResult:
        path = request.path
        if path in {"/portal/login", "/portal/status", "/portal/files/download"} or path.startswith("/portal/onboarding/"):
            return AuthenticationResult()
        machine_match = re.search(r"/execution-requests/([^/]+)/(identity|prepare|execute|sync|report|artifacts|connectivity)$", path)
        secret = request.headers.get("x-bonfire-execution-secret", "")
        if (machine_match and self.settings.execution_auth_mode == "shared-secret"
                and len(self.settings.execution_dispatch_secret) >= 32
                and hmac.compare_digest(secret, self.settings.execution_dispatch_secret)):
            configured = str(request.headers.get("x-bonfire-recipient") or request.configured_connector_id
                             or os.getenv("PORTAL_CONNECTOR_ID") or "")
            if not configured:
                profiles = self.state.load().get("connectors", {})
                configured = next(iter(profiles), "") if len(profiles) == 1 else ""
            if not configured:
                raise DomainError(403, "当前 Portal 未绑定连接器身份")
            return AuthenticationResult(configured, True)
        if machine_match and self.settings.execution_auth_mode == "signature" and request.headers.get("x-bonfire-signature"):
            configured = str(request.headers.get("x-bonfire-recipient") or request.configured_connector_id
                             or os.getenv("PORTAL_CONNECTOR_ID") or "")
            profile = self.state.load().get("connectors", {}).get(configured)
            signer = str(request.headers.get("x-bonfire-signer") or "")
            if not configured or not profile or not signer:
                raise DomainError(401, "执行签名上下文无效")
            if signer == "@center":
                identity_dir = Path(str(profile.get("identity_dir") or ""))
                certificate_path = next((p for p in (identity_dir / "platform-ca.pem", identity_dir / "ca-cert.pem") if p.is_file()), None)
                if certificate_path is None:
                    raise DomainError(503, "中心执行签名 CA 证书不可用")
                try:
                    certificate = certificate_path.read_text()
                except OSError as exc:
                    raise DomainError(503, "中心执行签名 CA 证书不可用") from exc
            else:
                identity = await PlatformClient(self.settings, None).machine_execution_identity(machine_match.group(1), profile, signer)
                certificate = str((identity or {}).get("certificate_pem") or (identity or {}).get("cert")
                                  or (identity or {}).get("certificate") or "")
            if not certificate:
                raise DomainError(403, "中心未返回对端机器证书")
            target = request.path + ("?" + request.query if request.query else "")
            verify_execution_signature(request.headers, request.method, target, request.body, configured, certificate, self.database)
            return AuthenticationResult(configured, True, signer)
        authorization = request.headers.get("authorization")
        if not authorization:
            raise DomainError(401, "缺少 Authorization 头")
        platform = PlatformClient(self.settings, authorization)
        user = await platform.me()
        username = str((user or {}).get("username") or "")
        if not username:
            raise DomainError(401, "无法识别当前用户")
        selected = self.state.selected(username)
        configured = str((selected or {}).get("connector_id") or request.configured_connector_id
                         or os.getenv("PORTAL_CONNECTOR_ID") or "")
        if not configured:
            raise DomainError(403, "当前用户未选择本地连接器")
        connectors = await platform.list_connectors()
        owned = {str(item.get("id")) for item in connectors if isinstance(item, dict)} if isinstance(connectors, list) else set()
        if configured not in owned:
            raise DomainError(403, "当前用户无权访问此连接器")
        return AuthenticationResult(configured, username=username)
