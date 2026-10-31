"""The CI gate must keep AI assistants and bots out of credited co-authors, not people."""

import runpy
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
POLICY = runpy.run_path(str(ROOT / "scripts" / "check_commit_trailers.py"))


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


@pytest.mark.parametrize(
    "co_author",
    [
        "Claude <noreply@anthropic.com>",
        "Claude Opus 5.5 <noreply@anthropic.com>",
        "multica-agent <github@multica.ai>",
        "Copilot <175728472+Copilot@users.noreply.github.com>",
        "claude[bot] <209825114+claude[bot]@users.noreply.github.com>",
    ],
)
def test_ai_and_bot_co_authors_are_rejected(co_author):
    # Squash merges place trailers mid-body, in any case and indentation.
    message = f"feat: add the canvas\n\n* fix: tidy up\n\n  co-AUTHORED-by: {co_author}\n\n* docs: explain"
    assert POLICY["non_human_co_authors"](message) == [co_author]
    with pytest.raises(ValueError, match="credit people") as error:
        POLICY["check"]([("0123456789abcdef", message)])
    assert f"0123456789ab feat: add the canvas: Co-authored-by: {co_author}" in str(error.value)


@pytest.mark.parametrize(
    "co_author",
    [
        "Claude Dupont <claude.dupont@example.com>",
        "Jane Doe <12345+janedoe@users.noreply.github.com>",
        "Bot Smith <noreply@anthropic.com.example>",
    ],
)
def test_people_stay_credited(co_author):
    POLICY["check"]([("0123456789abcdef", f"fix: repair\n\nCo-authored-by: {co_author}\n")])


def test_only_branch_commits_are_checked(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    git("init", "--initial-branch=main")
    git("config", "user.name", "Trailer Tests")
    git("config", "user.email", "trailers@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("commit", "--allow-empty", "-m", "chore: start\n\nCo-authored-by: Claude <noreply@anthropic.com>")
    base = git("rev-parse", "HEAD")
    git("commit", "--allow-empty", "-m", "feat: add\n\nCo-authored-by: Jane Doe <jane@example.com>")
    assert [message for _, message in POLICY["commits"](base)] == [
        "feat: add\n\nCo-authored-by: Jane Doe <jane@example.com>\n"
    ]
    POLICY["check"](POLICY["commits"](base))
    git("commit", "--allow-empty", "-m", "fix: repair\n\nCo-authored-by: multica-agent <github@multica.ai>")
    head = git("rev-parse", "HEAD")
    with pytest.raises(ValueError, match=f"{head[:12]} fix: repair"):
        POLICY["check"](POLICY["commits"](base))
    # Without a base, as on a new branch, the pushed commit is still checked.
    assert [sha for sha, _ in POLICY["commits"]("0" * 40)] == [head]
