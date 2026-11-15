"""Request values shared by the internal and versioned APIs."""

from dataclasses import dataclass

from fastapi import Request

from ..types import Record


@dataclass
class PartitionQuery:
    manifest: str | None = None
    partition_id: str | None = None
    partition_mode: str | None = None

    @property
    def context(self) -> Record | None:
        return (
            {
                "manifest": self.manifest,
                "partition_id": self.partition_id,
                "partition_mode": self.partition_mode,
            }
            if any((self.manifest, self.partition_id, self.partition_mode))
            else None
        )


def requester(request: Request) -> Record:
    """Who asked for a run; `service` marks service accounts, so history can tell them from people."""
    user = request.state.user
    record = {"id": user["id"], "username": user["username"], "token_name": request.state.token_name}
    if user.get("auth_method") == "service":
        record["service"] = True
    return record
