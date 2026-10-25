"""Release wheels carry the frontend; editable installs allow building it later."""

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
