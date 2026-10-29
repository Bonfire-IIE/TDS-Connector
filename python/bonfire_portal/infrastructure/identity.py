from __future__ import annotations

import hashlib
import hmac
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def _safe_username(username: str) -> str:
    return hashlib.sha256(username.encode("utf-8")).hexdigest()[:24]


def ensure_identity(data_dir: Path, username: str) -> dict[str, str]:
    directory = data_dir / "identity" / _safe_username(username)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    key_file = directory / "connector-key.pem"
    csr_file = directory / "connector.csr.pem"
    if key_file.exists():
        key = serialization.load_pem_private_key(key_file.read_bytes(), password=None)
    else:
        key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
        key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        key_file.chmod(0o600)
    csr = x509.CertificateSigningRequestBuilder().subject_name(x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "bonfire-connector-pending")
    ])).sign(key, hashes.SHA256())
    csr_pem = csr.public_bytes(serialization.Encoding.PEM)
    csr_file.write_bytes(csr_pem)
    csr_der = csr.public_bytes(serialization.Encoding.DER)
    public_der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    return {"csr_pem": csr_pem.decode(), "csr_fingerprint": hashlib.sha256(csr_der).hexdigest(),
            "public_key_fingerprint": hashlib.sha256(public_der).hexdigest(), "identity_dir": str(directory)}


def install_certificate(data_dir: Path, username: str, certificate_pem: str, ca_pem: str) -> str:
    directory = data_dir / "identity" / _safe_username(username)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    (directory / "connector-cert.pem").write_text(certificate_pem)
    (directory / "platform-ca.pem").write_text(ca_pem)
    return str(directory)


def validate_issued_certificate(identity_dir: str | Path, certificate_pem: str,
                                expected_fingerprint: str) -> str:
    """Verify that the center signed the locally generated connector key."""
    directory = Path(identity_dir)
    certificate = x509.load_pem_x509_certificate(certificate_pem.encode("utf-8"))
    actual = certificate.fingerprint(hashes.SHA256()).hex()
    expected = expected_fingerprint.replace(":", "").strip().lower()
    if not expected or not hmac.compare_digest(actual, expected):
        raise ValueError("issued certificate fingerprint does not match center metadata")
    private_key = serialization.load_pem_private_key(
        (directory / "connector-key.pem").read_bytes(), password=None
    )
    local_public = private_key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    issued_public = certificate.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    if not hmac.compare_digest(local_public, issued_public):
        raise ValueError("issued certificate does not match the local connector key")
    return actual
