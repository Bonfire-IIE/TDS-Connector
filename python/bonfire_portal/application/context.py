from __future__ import annotations

"""Composition root for the connector Portal application layer.

HTTP adapters should depend on this context instead of constructing domain
services and infrastructure clients ad hoc.  Keeping construction here makes
the bounded contexts explicit and gives tests a single seam for replacing
repositories or external clients.
"""

from dataclasses import dataclass

from .appimage import ApplicationImageService
from .audit import AuditService
from .data_movement import DataMovementService
from ..config import Settings
from .execution import ExecutionService
from .execution_gateway import ExecutionGatewayService
from .extraction import ExtractionService
from ..infrastructure.database import Database
from .onboarding import OnboardingService
from .node_operations import NodeOperationsService
from .operations import OperationsService
from .privacy_compute import PrivacyComputeService
from .runtime import BackgroundTaskScheduler, PortalRuntime
from .session import SessionService
from ..infrastructure.services import ServiceGateway
from ..infrastructure.state import PortalState


@dataclass(slots=True)
class PortalContext:
    settings: Settings
    database: Database
    state: PortalState
    data_movement: DataMovementService
    appimages: ApplicationImageService
    extractions: ExtractionService
    executions: ExecutionService
    execution_gateway: ExecutionGatewayService
    onboarding: OnboardingService
    privacy_compute: PrivacyComputeService
    operations: OperationsService
    sessions: SessionService
    audits: AuditService
    node_operations: NodeOperationsService
    services: ServiceGateway
    runtime: PortalRuntime

    @classmethod
    def build(cls, settings: Settings, database: Database, catalog=None) -> "PortalContext":
        services = ServiceGateway(settings)
        extraction = ExtractionService(database, settings, services)
        def endpoint_with_port(endpoint: str, port: object) -> str:
            value = str(endpoint or "").rstrip("/")
            if not value or not port:
                return value
            from urllib.parse import urlsplit
            try:
                return value if urlsplit(value).port is not None else value + ":" + str(int(port))
            except (ValueError, TypeError):
                return value

        state = PortalState(database)
        execution_service = ExecutionService(database, extraction)
        scheduler = BackgroundTaskScheduler()
        data_movement = DataMovementService(
            settings, database, state, extraction, scheduler.spawn
        )
        runtime = PortalRuntime(
            settings, database, state, extraction, execution_service, scheduler,
        )
        return cls(
            settings=settings,
            database=database,
            state=state,
            data_movement=data_movement,
            appimages=ApplicationImageService(database, state),
            extractions=extraction,
            executions=execution_service,
            execution_gateway=ExecutionGatewayService(settings, database, state, execution_service),
            onboarding=OnboardingService(settings, database, state, endpoint_with_port),
            privacy_compute=PrivacyComputeService(settings, state),
            operations=OperationsService(settings, database, state, services),
            sessions=SessionService(settings),
            audits=AuditService(settings, database),
            node_operations=NodeOperationsService(settings, state),
            services=services,
            runtime=runtime,
        )
