# Connector Portal backend architecture

Portal is the authenticated UI and HTTP gateway for independently deployed DI, DR and TS services.
The production backend is Python/FastAPI; React/Vite is the formal UI. Service demo pages are not embedded.

Browser data APIs use `/portal/services/{di,dr,ts}/...`. The gateway allowlists routes, resolves the
verified center user and connector to a service identity, and preserves service payloads, status codes,
revision and idempotency headers. Internal compute and locator APIs are machine-only.

Portal owns only connection identity, certificates, compute orchestration, AppImage registrations and
node operations. Its fresh `portal-services.sqlite` has no data-source, resource or ordinary-transfer
business tables. DI owns source credentials and all SeaTunnel submissions; DR owns resource metadata,
versions and publication; TS owns physical delivery, access and lifecycle state. Service databases and
internal domain objects are never imported by Portal.

Compute preparation: verified DR locator -> persisted binding snapshot -> Kuscia FTP session -> DI
compute transfer -> received-file verification -> DomainData registration -> peer grant -> KusciaJob.
Submission IDs and durable state support restart recovery. Portal no longer needs source/staging volumes
or a direct SeaTunnel connection. Legacy source implementations are not assembled or routed.

See [migration and deployment](microservices-migration.md) and [validation](VALIDATION-microservices.md).
