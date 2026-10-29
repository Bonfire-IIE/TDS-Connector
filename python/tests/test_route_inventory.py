from pathlib import Path

from bonfire_portal.api import create_router
from bonfire_portal.config import Settings
from bonfire_portal.infrastructure.database import Database


def test_python_router_covers_migrated_business_contract(tmp_path: Path):
    settings = Settings(portal_data_dir=tmp_path, storage_root=tmp_path)
    router = create_router(settings, Database(tmp_path / "portal.sqlite"))
    actual = {(method, route.path) for route in router.routes for method in route.methods}
    required = {
        ("POST", "/portal/login"), ("GET", "/portal/status"),
        ("GET", "/portal/onboarding/state"), ("POST", "/portal/onboarding/identity"),
        ("GET", "/portal/onboarding/connectors"), ("POST", "/portal/onboarding/register"),
        ("GET", "/portal/onboarding/deploy-script"), ("POST", "/portal/onboarding/upload-certs"),
        ("GET", "/portal/onboarding/discover"), ("POST", "/portal/onboarding/finalize"),
        ("GET", "/portal/datasources"), ("POST", "/portal/datasources"),
        ("DELETE", "/portal/datasources/{datasource_id}"),
        ("GET", "/portal/datasources/{datasource_id}/capability"),
        ("POST", "/portal/datasources/{datasource_id}/probe"),
        ("GET", "/portal/datasources/{datasource_id}/details"),
        ("GET", "/portal/datasources/{datasource_id}/objects"),
        ("POST", "/portal/datasources/{datasource_id}/inspect"),
        ("GET", "/portal/datasources/{datasource_id}/index"),
        ("POST", "/portal/datasources/{datasource_id}/index"),
        ("GET", "/portal/datasources/{datasource_id}/files"),
        ("POST", "/portal/datasources/{datasource_id}/scan"),
        ("GET", "/portal/resources"), ("POST", "/portal/resources/register"),
        ("PUT", "/portal/resources/{resource_id}"),
        ("DELETE", "/portal/resources/{resource_id}"),
        ("POST", "/portal/resources/{resource_id}/publish"),
        ("POST", "/portal/transfers/preview"), ("GET", "/portal/transfers/form"),
        ("POST", "/portal/transfers"), ("GET", "/portal/transfers"),
        ("GET", "/portal/transfers/{transfer_id}"),
        ("POST", "/portal/transfers/{transfer_id}/run"),
        ("GET", "/portal/movements"),
        ("POST", "/portal/extractions/prepare"), ("POST", "/portal/extractions/run"),
        ("GET", "/portal/extractions"), ("GET", "/portal/extractions/{extraction_id}"),
        ("POST", "/portal/extractions/{extraction_id}/credentials"),
        ("GET", "/portal/extractions/{extraction_id}/received"),
        ("POST", "/portal/extractions/{extraction_id}/complete"),
        ("POST", "/portal/extractions/{extraction_id}/cancel"),
        ("POST", "/portal/extractions/{extraction_id}/cleanup"),
        ("GET", "/portal/integrations/privacy-compute/state"),
        ("POST", "/portal/integrations/privacy-compute/provision"),
        ("POST", "/portal/integrations/privacy-compute/deploy-script"),
        ("POST", "/portal/integrations/privacy-compute/activate"),
        ("POST", "/portal/integrations/privacy-compute/appimages/register"),
        ("GET", "/portal/integrations/privacy-compute/appimages"),
        ("GET", "/portal/integrations/privacy-compute/execution-requests"),
        ("POST", "/portal/integrations/privacy-compute/execution-requests/{run_id}/identity"),
        ("POST", "/portal/integrations/privacy-compute/execution-requests/{run_id}/prepare"),
        ("POST", "/portal/integrations/privacy-compute/execution-requests/{run_id}/execute"),
        ("POST", "/portal/integrations/privacy-compute/execution-requests/{run_id}/sync"),
        ("POST", "/portal/integrations/privacy-compute/execution-requests/{run_id}/report"),
        ("GET", "/portal/files/status"), ("GET", "/portal/files"),
        ("PUT", "/portal/files"), ("POST", "/portal/files/mkdir"),
        ("POST", "/portal/files/delete"), ("POST", "/portal/files/rename"),
        ("POST", "/portal/files/download-ticket"), ("GET", "/portal/files/download"),
        ("GET", "/portal/logs/files"), ("GET", "/portal/logs/tail"),
        ("GET", "/portal/logs/download"), ("GET", "/portal/logs/stream"),
        ("GET", "/portal/overview"), ("GET", "/portal/routes"),
        ("DELETE", "/portal/routes/{destination}"),
        ("GET", "/portal/projects"), ("GET", "/portal/projects/{project_id}"),
        ("GET", "/portal/jobs/{job_id}/log"), ("GET", "/portal/audit/mirror"),
        ("POST", "/portal/audit/sync"),
    }
    retired = ('/portal/datasources', '/portal/resources', '/portal/transfers', '/portal/movements')
    required = {pair for pair in required if not pair[1].startswith(retired)}
    assert required <= actual
    assert not any(path.startswith(retired) for _, path in actual)
    assert ('GET', '/portal/services/{service}/{target:path}') in actual
