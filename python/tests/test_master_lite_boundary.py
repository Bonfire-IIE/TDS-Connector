import asyncio
from types import SimpleNamespace
import pytest
from bonfire_portal.application.appimage import ApplicationImageService
from bonfire_portal.application.execution import ExecutionService
from bonfire_portal.domain.errors import DomainError

def test_lite_cannot_publish_appimage_to_master():
    service=ApplicationImageService(None, SimpleNamespace(profile=lambda _: {'scheduling_mode':'master-lite'}))
    with pytest.raises(DomainError, match='中心登记'):
        asyncio.run(service.register_and_publish({'name':'untrusted'},'edge'))

def test_lite_profile_blocks_direct_job_submission_even_if_request_omits_mode(monkeypatch):
    service=ExecutionService(None)
    monkeypatch.setattr(service,'prepare',lambda *args: {})
    with pytest.raises(DomainError, match='中心 Master'):
        asyncio.run(service._execute('run','edge',{}, {'scheduling_mode':'master-lite'},None))
