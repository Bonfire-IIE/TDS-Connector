from __future__ import annotations

"""Managed background work and durable task recovery for the Portal."""

import asyncio
import logging
from collections.abc import Coroutine
from datetime import datetime, timezone
from typing import Any

from ..config import Settings
from ..infrastructure.database import Database
from ..infrastructure.platform import PlatformClient
from ..infrastructure.state import PortalState
from .execution import ExecutionService
from .extraction import ExtractionService


logger = logging.getLogger(__name__)


class BackgroundTaskScheduler:
    def __init__(self) -> None:
        self.tasks: set[asyncio.Task[Any]] = set()
        self.active: set[str] = set()

    def spawn(self, key: str, coroutine: Coroutine[Any, Any, Any]) -> bool:
        if key in self.active:
            coroutine.close()
            return False
        self.active.add(key)

        async def guarded() -> None:
            try:
                await coroutine
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("background task failed: %s", key)
            finally:
                self.active.discard(key)

        task = asyncio.create_task(guarded(), name=f"portal:{key}")
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return True

    async def close(self) -> None:
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)


class PortalRuntime:
    def __init__(self, settings: Settings, database: Database, state: PortalState,
                 extractions: ExtractionService, executions: ExecutionService,
                 scheduler: BackgroundTaskScheduler):
        self.settings, self.database, self.state = settings, database, state
        self.extractions, self.executions = extractions, executions
        self.scheduler = scheduler

    def start(self) -> None:
        self.scheduler.spawn("supervisor:recovery", self._recovery_loop())

    async def stop(self) -> None:
        await self.scheduler.close()

    async def _recover_execution(self, row: dict[str, Any], profile: dict[str, Any]) -> None:
        result = await self.executions.sync(row["run_id"], row["connector_id"], profile)
        report: dict[str, Any] = {
            "connector_id": row["connector_id"],
            "status": result.get("status"),
            "external_run_ref": result.get("external_run_ref"),
        }
        if result.get("status") == "succeeded":
            report["result"] = {
                "outputs": result.get("outputs") or {},
                "output_ref": result.get("output_ref"),
                "output_uri": result.get("output_uri"),
                "output_format": result.get("output_format"),
            }
        elif result.get("status") in {"failed", "cancelled"}:
            status = result.get("kuscia_status") or {}
            report["error"] = str(
                status.get("message") or status.get("reason") or result.get("status")
            )[:1000]
        await PlatformClient(self.settings, None).machine_report_execution(row["run_id"], profile, report)
        if result.get("status") in {"succeeded", "failed", "cancelled"}:
            result["terminal_reported"] = True
            self.executions.save(row["run_id"], row["connector_id"], result)

    async def _recovery_loop(self) -> None:
        while True:
            try:
                self._schedule_recoverable_tasks()
            except Exception:
                logger.exception("recovery inventory scan failed")
            await asyncio.sleep(15)

    def _schedule_recoverable_tasks(self) -> None:
        profiles = self.state.load().get("connectors", {})
        extraction_states = {
            "queued", "creating-session", "extracting", "uploading", "validating",
            "committing", "staged", "registering", "running", "awaiting-upload",
        }
        for row in self.database.durable_list("extraction"):
            if row.get("state") not in extraction_states:
                continue
            # Manual sessions wait for an explicit completion call after the
            # operator has uploaded and confirmed a file list.
            if row.get("mode") == "manual" and not row.get("expected_files"):
                continue
            profile = profiles.get(row.get("connector_id"))
            if profile:
                self.scheduler.spawn(
                    f"extraction:{row['id']}",
                    self.extractions.run(row["id"], row["connector_id"], profile),
                )
        for row in self.database.durable_list("execution"):
            profile = profiles.get(row.get("connector_id"))
            if not row.get('submitted'):
                if profile and row.get('validated') and row.get('request') and not row.get('prepared_bundle'):
                    self.scheduler.spawn(f"preparation:{row['run_id']}:{row['connector_id']}",
                        self.executions.execute(row['run_id'], row['connector_id'], row['request'], profile,
                                                self.database, prepare_only=True))
                continue
            if row.get('terminal_reported'): continue
            if profile:
                self.scheduler.spawn(
                    f"execution:{row['run_id']}:{row['connector_id']}",
                    self._recover_execution(row, profile),
                )

