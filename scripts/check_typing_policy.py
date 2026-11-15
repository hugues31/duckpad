"""Keep gradual typing exceptions explicit and prevent their growth in CI."""

from __future__ import annotations

import os
import re
import subprocess
import tomllib
from pathlib import Path


def exceptions(document: dict) -> set[tuple[str, str]]:
    config = document["tool"]["ty"]
    if config.get("baseline") or config.get("src") != {
        "include": ["src/duckpad"],
        "respect-ignore-files": False,
    }:
        raise ValueError("Check every backend file; baselines and source exclusions are not allowed")
    if any(level == "ignore" for level in config.get("rules", {}).values()):
        raise ValueError("Global typing suppressions are not allowed")
    result = set()
    for section in [config, *config.get("overrides", [])]:
        analysis = section.get("analysis", {})
        if analysis.get("allowed-unresolved-imports") or analysis.get("replace-imports-with-any"):
            raise ValueError("Import exclusions are not allowed")
        if analysis.get("respect-type-ignore-comments", False):
            raise ValueError("Use ty diagnostics instead of blanket type-ignore comments")
    if config.get("analysis", {}).get("respect-type-ignore-comments") is not False:
        raise ValueError("Disable blanket type-ignore comments explicitly")
    for override in config.get("overrides", []):
        if override.get("exclude"):
            raise ValueError("Override exclusions are not allowed")
        for rule, level in override.get("rules", {}).items():
            if level != "ignore":
                continue
            if rule == "all" or not override.get("include"):
                raise ValueError("Suppress only named rules in named files")
            for path in override["include"]:
                if not re.fullmatch(r"src/duckpad/(?:[a-z_]+/)*[a-z_]+\.py", path):
                    raise ValueError(f"Use an exact backend file for {rule}: {path}")
                result.add((path, rule))
    return result


def typing_rules(rules: list[str]) -> set[str]:
    return {
        rule
        for rule in rules
        if rule.startswith(("ANN", "PYI")) or "ANN".startswith(rule) or "PYI".startswith(rule)
    }


def check(current: dict, previous: dict | None) -> None:
    current_exceptions = exceptions(current)
    # Initial adoption establishes the baseline; later changes can only remove entries.
    if previous is not None and "ty" in previous.get("tool", {}):
        added = current_exceptions - exceptions(previous)
        if added:
            raise ValueError(f"Typing exceptions may only shrink: {sorted(added)}")
        current_lint = current["tool"]["ruff"]["lint"]
        previous_lint = previous["tool"]["ruff"]["lint"]
        for key in ("select", "extend-select"):
            if typing_rules(previous_lint.get(key, [])) - typing_rules(current_lint.get(key, [])):
                raise ValueError("Keep the lint rules that enforce typing signatures")
        for key in ("ignore", "extend-ignore"):
            if typing_rules(current_lint.get(key, [])) - typing_rules(previous_lint.get(key, [])):
                raise ValueError("Lint exceptions may only shrink")
        for key in ("per-file-ignores", "extend-per-file-ignores"):
            for path, rules in current_lint.get(key, {}).items():
                if typing_rules(rules) - typing_rules(previous_lint.get(key, {}).get(path, [])):
                    raise ValueError(f"Lint exceptions may only shrink: {path}")


def main() -> None:
    current = tomllib.loads(Path("pyproject.toml").read_text())
    base = os.environ.get("BASE_SHA", "")
    previous = None
    if base and set(base) != {"0"}:
        previous = tomllib.loads(
            subprocess.check_output(["git", "show", f"{base}:pyproject.toml"], text=True)
        )
    check(current, previous)
    print("Typing exception policy passed")


if __name__ == "__main__":
    main()
