"""Directory layout of an instance home, the only place that names its folders."""

from __future__ import annotations

from pathlib import Path


class InstancePaths:
    def __init__(self, home: str | Path) -> None:
        self.home = Path(home)

    @property
    def extensions(self) -> Path:
        """The private DuckDB extension cache shared by every SQL worker."""
        return self.home / "extensions"

    @property
    def artifacts(self) -> Path:
        """Private copies of completed file exports, offered for download."""
        return self.home / "artifacts"

    def project(self, project: str) -> Path:
        """The main Git repository of a project."""
        return self.home / "projects" / project

    def resources(self, project: str) -> Path:
        """Uploaded and sample source files of a project."""
        return self.home / "resources" / project

    def worktree(self, worktree: str) -> Path:
        """The checkout of a branch opened next to the main repository."""
        return self.home / "worktrees" / worktree

    def exports(self, worktree: str, environment: str | None = None) -> Path:
        """Files exported by a worktree, or its default directory for relative destinations."""
        path = self.home / "exports" / worktree
        return path / environment if environment else path

    def project_files(self, project: str, worktree: str, environment: str) -> dict[str, Path]:
        """Where relative paths without a connection root resolve, by template parameter type.

        Sources read the project's resources, where uploads land; destinations write to the
        exports of the worktree in that environment.
        """
        return {"file": self.resources(project), "destination": self.exports(worktree, environment)}

    def worktree_directories(self) -> list[Path]:
        """Every directory with one child per recorded worktree, named after it."""
        return [self.home / "worktrees", self.home / "exports"]
