"""Services shared by the application's router factories."""

from dataclasses import dataclass

from ..access import Access
from ..assistant.service import Assistant
from ..auth import Auth
from ..jobs import Jobs
from ..monitoring import Monitoring
from ..oidc import OIDC
from ..services import Services


@dataclass(frozen=True)
class Context:
    services: Services
    auth: Auth
    oidc: OIDC
    jobs: Jobs
    monitoring: Monitoring
    assistant: Assistant

    @property
    def access(self) -> Access:
        return self.services.engine.access
