"""Write DI token digests from environment; prints no raw credentials."""
import hashlib
import json
import os
from pathlib import Path


def main():
    tenant, connector = os.environ['SERVICE_TENANT'], os.environ['SERVICE_CONNECTOR']
    entries = []
    for name, subject, roles in [
        ('PORTAL_ALICE_DI_TOKEN', 'alice', ['source:read', 'source:write', 'transfer:read', 'transfer:write']),
        ('PORTAL_MACHINE_DI_TOKEN', 'portal-compute', ['compute:transfer']),
    ]:
        token = os.environ[name]
        if len(token) < 32 or token.startswith('replace-'): raise ValueError('configure_real_tokens_first')
        entries.append({'tenant_id': tenant, 'connector_id': connector, 'subject': subject, 'roles': roles,
                        'token_sha256': hashlib.sha256(token.encode()).hexdigest()})
    path = Path('di-identities.json')
    with path.open('x') as output: json.dump(entries, output, indent=2)
    path.chmod(0o600)

if __name__ == '__main__': main()
