"""The CI gate must reject broader exceptions while allowing gradual cleanup."""

import copy
import runpy
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
POLICY = runpy.run_path(str(ROOT / "scripts" / "check_typing_policy.py"))


def configuration():
    return tomllib.loads((ROOT / "pyproject.toml").read_text())


def test_initial_adoption_and_removing_exceptions():
    original = configuration()
    POLICY["check"](original, None)
    current = copy.deepcopy(original)
    current["tool"]["ty"]["overrides"].pop()
    POLICY["check"](current, original)


@pytest.mark.parametrize("path", ["src/duckpad/new.py", "src/duckpad/*.py", "**", "../other.py"])
def test_new_or_broader_exceptions_are_rejected(path):
    original = configuration()
    current = copy.deepcopy(original)
    current["tool"]["ty"]["overrides"].append(
        {"include": [path], "rules": {"invalid-argument-type": "ignore"}}
    )
    with pytest.raises(ValueError, match=r"Typing exceptions|Use an exact"):
        POLICY["check"](current, original)


@pytest.mark.parametrize(
    ("setting", "value"),
    [
        ("src", {"include": ["src/duckpad"], "exclude": ["src/duckpad/engine.py"]}),
        ("rules", {"invalid-argument-type": "ignore"}),
        ("analysis", {"replace-imports-with-any": ["duckpad.**"]}),
        ("analysis", {"respect-type-ignore-comments": True}),
        ("baseline", "ignored.json"),
        ("overrides", [{"include": ["src/duckpad/engine.py"], "rules": {"all": "ignore"}}]),
    ],
)
def test_global_bypasses_are_rejected(setting, value):
    original = configuration()
    current = copy.deepcopy(original)
    current["tool"]["ty"][setting] = value
    with pytest.raises(ValueError, match=r"not allowed|blanket|named rules"):
        POLICY["check"](current, original)


def test_signature_checks_cannot_be_disabled():
    original = configuration()
    current = copy.deepcopy(original)
    current["tool"]["ruff"]["lint"]["extend-select"].remove("ANN001")
    with pytest.raises(ValueError, match="typing signatures"):
        POLICY["check"](current, original)
    current = copy.deepcopy(original)
    current["tool"]["ruff"]["lint"]["per-file-ignores"]["src/duckpad/engine.py"] = ["ANN"]
    with pytest.raises(ValueError, match="Lint exceptions"):
        POLICY["check"](current, original)
