"""FastAPI adapters for Portal bounded contexts."""

from .appimage import AppImageHttpAdapter
from .execution import PrivacyExecutionHttpAdapter
from .onboarding import OnboardingHttpAdapter
from .movement import MovementHttpAdapter
from .privacy_compute import PrivacyComputeHttpAdapter
from .audit import AuditHttpAdapter
from .operations import OperationsHttpAdapter
from .session import SessionHttpAdapter

__all__ = [
    "AppImageHttpAdapter", "AuditHttpAdapter",
    "MovementHttpAdapter", "OnboardingHttpAdapter", "OperationsHttpAdapter",
    "PrivacyComputeHttpAdapter", "PrivacyExecutionHttpAdapter", "SessionHttpAdapter",
]
