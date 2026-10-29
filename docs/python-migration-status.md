> Historical Python migration record. Current service boundaries and rollout instructions are in [microservices-migration.md](microservices-migration.md). The local data APIs described below have been retired.

# Python Portal Migration Status

The Python implementation is the only Connector Portal backend. `Dockerfile`
builds the React bundle and a single-worker FastAPI runtime. The migrated
TypeScript backend and transitional Dockerfiles have been removed.

Implemented in this stage:

- Opaque versioned `object_ref` values that never contain credentials.
- SQLite WAL migrations and catalog tables, including FTS5 search.
- LocalFS, S3/OSS, FTP and SFTP discovery adapters.
- MySQL/PostgreSQL table and view discovery through SQLAlchemy.
- CSV/JSON/JSONL, Parquet/ORC and Excel inspection.
- `/portal/datasources/{id}/capability`, `/objects`, `/inspect`, `/index`.
- Compatibility `/files` and `/scan` routes for the current frontend.
- Connector-scoped standard resource registration, update, delete and publish routes,
  persisted in SQLite and projected to the center with Bearer forwarding.
- Login/overview and the onboarding identity/register/upload/finalize route slice,
  including local RSA-3072 CSR generation and private-key-only persistence.
- Initial Kuscia Lite mTLS adapter for Domain, DomainData, DomainDataGrant, route
  and job calls, now used by extraction and execution slices.
- Transfers and extraction task slices with SeaTunnel HTTP submission, Kuscia FTP
  session calls, durable idempotency and DomainData registration.
- Privacy execution request persistence and KusciaJob submission/status reporting.
- Bearer/center ownership guard for non-public Portal routes.

Generated deployments use three independent persistent volumes. `/state`
contains SQLite state, connector private keys and engine client certificates;
`/data` is the Connector LFS exposed read-only to its dedicated SeaTunnel
instance; `/var/lib/bonfire/staging` is the transfer workspace. SeaTunnel never
mounts `/state`.

The default Docker runtime and root `npm start` launch Python/FastAPI.

A deployed two-Connector PSI verification has been completed after the source
and contract suites passed. The center run `6c40145e-e4c7-423f-be1d-02705dba75a9`
reached `succeeded` with external KusciaJob
`kuscia-38cb05153f57e6aa0fc0ca5f2b47`; the corresponding KusciaJob and
KusciaTask were both `Succeeded`, both parties reported `JobAccepted`, and
`/home/kuscia/var/storage/data/outputs/kuscia-38cb05153f57e6aa0fc0ca5f2b47.csv`
was produced by the task. The result file contains the expected CSV header
and intersection output. This evidence is separate from the unit and route
tests and verifies the complete Connector, SeaTunnel, Kuscia and AppImage
execution path.
