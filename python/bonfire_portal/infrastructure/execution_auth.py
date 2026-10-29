from __future__ import annotations

import base64
import hashlib
import secrets
import time
from datetime import timezone
from pathlib import Path
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

from ..config import Settings
from ..domain.errors import DomainError
from .database import Database


def _message(signer: str, recipient: str, timestamp: str, nonce: str,
             method: str, target: str, body: bytes) -> bytes:
    digest = hashlib.sha256(body).hexdigest()
    return "\n".join([
        "bonfire-execution-v1", signer, recipient, timestamp, nonce,
        method.upper(), target, digest,
    ]).encode()


def execution_headers(profile: dict[str, Any], recipient: str, method: str,
                      target: str, body: bytes, settings: Settings) -> dict[str, str]:
    if settings.execution_auth_mode == "shared-secret":
        if len(settings.execution_dispatch_secret) < 32:
            raise DomainError(503, "执行共享密钥未配置")
        return {"X-Bonfire-Execution-Secret": settings.execution_dispatch_secret}
    identity = Path(str(profile.get("identity_dir") or ""))
    key_file = identity / "connector-key.pem"
    if not key_file.is_file() or key_file.stat().st_mode & 0o077:
        raise DomainError(503, "机器私钥必须为权限受限的普通文件")
    key = serialization.load_pem_private_key(key_file.read_bytes(), password=None)
    timestamp, nonce = str(int(time.time())), secrets.token_hex(24)
    signature = key.sign(
        _message(profile["connector_id"], recipient, timestamp, nonce, method, target, body),
        padding.PKCS1v15(), hashes.SHA256(),
    )
    return {
        "X-Bonfire-Signer": profile["connector_id"],
        "X-Bonfire-Recipient": recipient,
        "X-Bonfire-Timestamp": timestamp,
        "X-Bonfire-Nonce": nonce,
        "X-Bonfire-Signature": base64.b64encode(signature).decode(),
    }


def verify_execution_signature(headers: Any, method: str, target: str, body: bytes,
                               recipient: str, certificate_pem: str,
                               database: Database) -> str:
    signer = str(headers.get("x-bonfire-signer") or "")
    claimed = str(headers.get("x-bonfire-recipient") or "")
    timestamp = str(headers.get("x-bonfire-timestamp") or "")
    nonce = str(headers.get("x-bonfire-nonce") or "")
    encoded = str(headers.get("x-bonfire-signature") or "")
    if (not signer or claimed != recipient or not timestamp.isdigit()
            or abs(time.time() - int(timestamp)) > 60 or len(nonce) != 48):
        raise DomainError(401, "执行签名上下文无效或已过期")
    certificate = x509.load_pem_x509_certificate(certificate_pem.encode())
    now = time.time()
    not_before = getattr(certificate, "not_valid_before_utc", None)
    not_after = getattr(certificate, "not_valid_after_utc", None)
    if not_before is None or not_after is None:
        not_before = certificate.not_valid_before.replace(tzinfo=timezone.utc)
        not_after = certificate.not_valid_after.replace(tzinfo=timezone.utc)
    if not_before.timestamp() > now or not_after.timestamp() <= now:
        raise DomainError(403, "执行签名证书已过期")
    try:
        certificate.public_key().verify(
            base64.b64decode(encoded),
            _message(signer, recipient, timestamp, nonce, method, target, body),
            padding.PKCS1v15(), hashes.SHA256(),
        )
    except Exception as exc:
        raise DomainError(401, "执行请求签名无效") from exc
    nonce_key = hashlib.sha256(f"{signer}\n{recipient}\n{nonce}".encode()).hexdigest()
    existing = database.durable_read("execution_nonce", nonce_key)
    if existing and int(existing.get("expires_at") or 0) >= int(now):
        raise DomainError(409, "执行签名已使用，请重新签名后重试")
    if existing:
        database.connection().execute(
            "DELETE FROM durable_record WHERE scope=? AND key=?",
            ("execution_nonce", nonce_key),
        )
    database.durable_write(
        "execution_nonce", nonce_key, {"expires_at": int(timestamp) + 61}, "used"
    )
    return signer
