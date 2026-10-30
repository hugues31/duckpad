"""Directory layout of an instance home, the only place that names its folders."""

from pathlib import Path


class InstancePaths:
    def __init__(self, home):
        self.home = Path(home)

    @property
    def extensions(self):
        """The private DuckDB extension cache shared by every SQL worker."""
        return self.home / "extensions"

    @property
    def artifacts(self):
        """Private copies of completed file exports, offered for download."""
        return self.home / "artifacts"

    def project(self, project):
        """The main Git repository of a project."""
        return self.home / "projects" / project

    def resources(self, project):
        """Uploaded and sample source files of a project."""
        return self.home / "resources" / project

    def worktree(self, worktree):
        """The checkout of a branch opened next to the main repository."""
        return self.home / "worktrees" / worktree

    def exports(self, worktree, environment=None):
        """Files exported by a worktree, or its default directory for relative destinations."""
        path = self.home / "exports" / worktree
        return path / environment if environment else path

    def worktree_directories(self):
        """Every directory with one child per recorded worktree, named after it."""
        return [self.home / "worktrees", self.home / "exports"]
