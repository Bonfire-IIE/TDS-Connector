from pathlib import Path

from bonfire_portal.application.runtime import PortalRuntime
from bonfire_portal.config import Settings
from bonfire_portal.infrastructure.database import Database
from bonfire_portal.infrastructure.state import PortalState


class Scheduler:
    def __init__(self):
        self.keys = []

    def spawn(self, key, coroutine):
        self.keys.append(key)
        coroutine.close()
        return True


class Extraction:
    async def run(self, *_args):
        return None


class Movement:
    async def run(self, *_args):
        return None


class Execution:
    async def execute(self, *_args, **_kwargs):
        return None

    async def sync(self, *_args):
        return None


class Catalog:
    def index_status(self, *_args):
        return None

    def start_index(self, *_args):
        return None


def runtime(tmp_path: Path):
    database = Database(tmp_path / "portal.sqlite")
    state = PortalState(database)
    state.save_profile("owner", {"connector_id": "connector-a"})
    scheduler = Scheduler()
    value = PortalRuntime(
        Settings(), database, state, Extraction(), Execution(), scheduler
    )
    return value, database, scheduler


def test_runtime_recovers_queued_automatic_extraction(tmp_path: Path):
    value, database, scheduler = runtime(tmp_path)
    database.durable_write("extraction", "ing-a", {
        "id": "ing-a", "connector_id": "connector-a", "state": "queued", "mode": "seatunnel",
    }, "queued")

    value._schedule_recoverable_tasks()

    assert scheduler.keys == ["extraction:ing-a"]


def test_runtime_does_not_run_unconfirmed_manual_upload(tmp_path: Path):
    value, database, scheduler = runtime(tmp_path)
    database.durable_write("extraction", "ing-manual", {
        "id": "ing-manual", "connector_id": "connector-a", "state": "uploading", "mode": "manual",
    }, "uploading")

    value._schedule_recoverable_tasks()

    assert scheduler.keys == []


def test_runtime_never_resumes_legacy_transfers(tmp_path):
    value, database, scheduler = runtime(tmp_path)
    database.durable_write('transfer', 'old', {'id': 'old', 'connector_id': 'connector-a', 'state': 'running'}, 'running')
    value._schedule_recoverable_tasks()
    assert scheduler.keys == []


def test_runtime_resumes_preparation_without_browser_or_dispatch(tmp_path):
    value, database, scheduler = runtime(tmp_path)
    database.durable_write('execution', 'run', {'run_id': 'run', 'connector_id': 'connector-a',
        'validated': True, 'request': {'resources': []}, 'status': 'accepted'}, 'accepted')
    value._schedule_recoverable_tasks()
    assert scheduler.keys == ['preparation:run:connector-a']
