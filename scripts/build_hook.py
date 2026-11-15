"""Release wheels carry the frontend and the assistant's guides; editable installs read them in place.

The package description is the README with its repository links made absolute, because PyPI shows it
outside the repository.
"""

import re
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface
from hatchling.metadata.plugin.interface import MetadataHookInterface

# The target of a Markdown link or image, or of an HTML src, srcset or href attribute.
TARGET = re.compile(r'(\]\(|\b(?:src|srcset|href)=")([^)"\s]+)')
IMAGES = (".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp")


def published_links(text, repository, version):
    """Point the README's relative targets at the files of the released tag, outside code blocks."""
    pages = f"{repository}/blob/v{version}"
    files = f"{repository.replace('github.com', 'raw.githubusercontent.com', 1)}/v{version}"

    def absolute(match):
        target = match[2]
        if re.match(r"[a-z][a-z0-9+.-]*:|[#/]", target, re.IGNORECASE):
            return match[0]
        image = target.partition("#")[0].lower().endswith(IMAGES)
        return f"{match[1]}{files if image else pages}/{target}"

    lines, fenced = [], False
    for line in text.splitlines(keepends=True):
        if line.lstrip().startswith("```"):
            fenced = not fenced
        lines.append(line if fenced else TARGET.sub(absolute, line))
    return "".join(lines)


class ReadmeHook(MetadataHookInterface):
    def update(self, metadata):
        readme = Path(self.root, "README.md").read_text(encoding="utf-8")
        metadata["readme"] = {
            "content-type": "text/markdown",
            "text": published_links(readme, metadata["urls"]["Repository"], metadata["version"]),
        }


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
