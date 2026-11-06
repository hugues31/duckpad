"""Release wheels carry the frontend and the assistant's guides; editable installs read them in place."""

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class FrontendHook(BuildHookInterface):
    def initialize(self, version, build_data):
        if version == "editable":
            return
        frontend = Path(self.root) / "src/duckpad/static"
        if not (frontend / "index.html").exists():
            raise RuntimeError(
                "Build the frontend first: npm ci --prefix frontend && npm run build --prefix frontend"
            )
        build_data["force_include"][str(frontend)] = (
            "duckpad/static" if self.target_name == "wheel" else "src/duckpad/static"
        )
        if self.target_name == "wheel":
            # Every published guide, without Git-ignored operator files such as docs/MULTICA.md.
            for guide in sorted(Path(self.root, "docs").glob("*.md")):
                if not self.build_config.path_is_excluded(f"docs/{guide.name}"):
                    build_data["force_include"][str(guide)] = f"duckpad/assistant/guides/{guide.name}"
