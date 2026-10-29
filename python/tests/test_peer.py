from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from bonfire_portal.config import Settings
from bonfire_portal.domain.errors import DomainError
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.infrastructure.execution_auth import execution_headers, verify_execution_signature


def test_signed_execution_request_and_replay_guard(tmp_path: Path):
    identity = tmp_path / "identity"; identity.mkdir(mode=0o700)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_file = identity / "connector-key.pem"
    key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key_file.chmod(0o600)
    now = datetime.now(timezone.utc)
    certificate = x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "sender")])).issuer_name(
        x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "sender")])).public_key(key.public_key()).serial_number(1).not_valid_before(
        now - timedelta(minutes=1)).not_valid_after(now + timedelta(minutes=5)).sign(key, hashes.SHA256())
    pem = certificate.public_bytes(serialization.Encoding.PEM).decode()
    body = b'{"execution_request":{}}'; target = "/portal/integrations/privacy-compute/execution-requests/run-1/prepare"
    headers = execution_headers({"connector_id": "sender", "identity_dir": str(identity)}, "receiver", "POST", target, body, Settings())
    lowered = {key.lower(): value for key, value in headers.items()}
    db = Database(tmp_path / "portal.sqlite")
    assert verify_execution_signature(lowered, "POST", target, body, "receiver", pem, db) == "sender"
    with pytest.raises(DomainError, match="已使用"):
        verify_execution_signature(lowered, "POST", target, body, "receiver", pem, db)
