"""Exercise release guards and notes against real Git histories."""

import importlib.util
import subprocess
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location("release", Path(__file__).parents[1] / "scripts/release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


@pytest.fixture
def repository(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("GITHUB_OUTPUT", raising=False)
    git("init", "--initial-branch=main")
    git("config", "user.name", "Release Tests")
    git("config", "user.email", "release@example.invalid")
    git("config", "commit.gpgsign", "false")
    git("config", "tag.gpgsign", "false")

    def commit(message, version=None, tag=None, annotated=False):
        if version:
            Path("pyproject.toml").write_text(f'[project]\nname = "duckpad"\nversion = "{version}"\n')
            git("add", "pyproject.toml")
        git("commit", "--allow-empty", "-m", message)
        git("update-ref", "refs/remotes/origin/main", "HEAD")
        if tag:
            git("tag", *(["-a", "-m", tag] if annotated else []), tag)
        return git("rev-parse", "HEAD")

    return commit


@pytest.mark.parametrize("version", ["1.2.3", "0.1.0a1", "0.1.0b2", "0.1.0rc1"])
def test_release_versions_and_github_outputs(repository, monkeypatch, tmp_path, version):
    repository("feat: add the canvas", version, "v" + version, annotated=True)
    output = tmp_path / "outputs"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    notes = tmp_path / "notes.md"
    actual_version, prerelease = release.prepare_release("v" + version, "example/duckpad", notes)
    assert actual_version == version
    assert prerelease is (version != "1.2.3")
    assert f"version={version}\nprerelease={str(prerelease).lower()}\n" == output.read_text()
    assert f"pip install duckpad=={version}" in notes.read_text()
    assert ("**Pre-release:**" in notes.read_text()) is prerelease


@pytest.mark.parametrize("tag", ["1.2.3", "v1.2", "v01.2.3", "v1.2.3-rc.1", "v1.2.3+local", "v1.2.3rc01"])
def test_invalid_tag_is_rejected(repository, tag):
    with pytest.raises(ValueError, match="Use vMAJOR"):
        release.validate_tag(tag)


def test_mismatched_version_is_rejected(repository):
    repository("feat: add canvas", "0.1.0", "v0.2.0")
    with pytest.raises(ValueError, match="does not match"):
        release.validate_tag("v0.2.0")


def test_tag_must_match_checkout(repository):
    repository("feat: add canvas", "0.1.0", "v0.1.0")
    repository("fix: change canvas")
    with pytest.raises(ValueError, match="checked-out commit"):
        release.validate_tag("v0.1.0")


def test_unmerged_commit_is_rejected(repository):
    merged = repository("feat: add canvas", "0.1.0")
    repository("feat: add export", "0.2.0", "v0.2.0")
    git("update-ref", "refs/remotes/origin/main", merged)
    with pytest.raises(ValueError, match="already merged"):
        release.validate_tag("v0.2.0")


def test_first_release_groups_changes_and_retains_breaking_details(repository, tmp_path):
    feature = repository("feat(canvas): add the editor", "0.1.0")
    repository("fix: preserve selection")
    repository("perf: reduce query overhead")
    repository("docs: explain installation")
    repository("chore: hide release bookkeeping")
    repository("Merge branch 'topic'")
    repository("feat(api)!: require sessions\n\nBREAKING CHANGE: Sign in before running queries.")
    repository("chore!: remove legacy settings\n\nBREAKING CHANGE: Move settings to the instance directory.")
    repository("fix: update authentication\n\nBREAKING-CHANGE: Rotate old tokens.", tag="v0.1.0")
    notes = tmp_path / "notes.md"
    release.prepare_release("v0.1.0", "example/duckpad", notes)
    text = notes.read_text()
    assert text.index("### Breaking changes") < text.index("### Features") < text.index("### Fixes")
    assert "### Performance" in text and "### Documentation" in text
    assert "**canvas:** Add the editor" in text
    assert "Sign in before running queries." in text
    assert "Move settings to the instance directory." in text
    assert "Rotate old tokens." in text
    assert f"https://github.com/example/duckpad/commit/{feature}" in text
    assert "https://github.com/example/duckpad/commits/v0.1.0" in text
    assert "bookkeeping" not in text and "Merge branch" not in text


@pytest.mark.parametrize("tag", ["v0.2.0rc2", "v0.2.0"])
def test_notes_cover_changes_since_previous_stable_including_prereleases(repository, tmp_path, tag):
    repository("feat: previous release feature", "0.1.0", "v0.1.0", annotated=True)
    repository("feat: add export", "0.2.0rc1", "v0.2.0rc1")
    repository("fix: handle empty exports", tag="unrelated-tag")
    repository("chore: prepare release", tag[1:], tag)
    notes = tmp_path / "notes.md"
    release.prepare_release(tag, "example/duckpad", notes)
    text = notes.read_text()
    assert "Previous release feature" not in text
    assert "Add export" in text and "Handle empty exports" in text
    assert f"compare/v0.1.0...{tag}" in text
    assert text.count("## Duckpad") == 1


@pytest.mark.parametrize("kind", ["feat", "fix"])
def test_notes_omit_merge_summaries_and_keep_branch_changes(repository, tmp_path, kind):
    repository("feat: previous release feature", "0.1.0", "v0.1.0")
    git("checkout", "-b", "topic")
    change = repository(f"{kind}(export): handle empty exports", "0.2.0")
    breaking = repository(
        "chore!: remove legacy export settings\n\nBREAKING CHANGE: Use the new export settings."
    )
    git("checkout", "main")
    git("merge", "--no-ff", "topic", "-m", f"{kind}(export): handle empty exports (#42)")
    merge = git("rev-parse", "HEAD")
    # Squashed PRs have one parent and must remain visible, even with a PR suffix.
    squash = repository("fix(export): preserve column names (#43)", tag="v0.2.0")

    notes = tmp_path / "notes.md"
    release.prepare_release("v0.2.0", "example/duckpad", notes)
    text = notes.read_text()
    assert text.count("Handle empty exports") == 1
    assert f"/commit/{change}" in text
    assert f"/commit/{breaking}" in text
    assert "Use the new export settings." in text
    assert "Preserve column names (#43)" in text and f"/commit/{squash}" in text
    assert f"/commit/{merge}" not in text and "(#42)" not in text
    assert "Previous release feature" not in text
    assert "compare/v0.1.0...v0.2.0" in text


def test_breaking_merge_summaries_are_omitted_only_when_the_branch_lists_them(repository, tmp_path):
    repository("feat: previous release feature", "0.1.0", "v0.1.0")
    git("checkout", "-b", "storage")
    storage = repository("refactor(storage)!: adopt relational metadata", "0.2.0")
    git("checkout", "-b", "settings", "main")
    settings = repository("refactor(settings): move instance settings")
    git("checkout", "main")
    git("merge", "--no-ff", "storage", "-m", "refactor(storage)!: adopt relational storage (#44)")
    duplicate = git("rev-parse", "HEAD")
    git("merge", "--no-ff", "settings", "-m", "refactor(settings)!: move instance settings (#45)")
    merge_only = git("rev-parse", "HEAD")
    git("update-ref", "refs/remotes/origin/main", "HEAD")
    git("tag", "v0.2.0")

    notes = tmp_path / "notes.md"
    release.prepare_release("v0.2.0", "example/duckpad", notes)
    text = notes.read_text()
    assert f"/commit/{storage}" in text and "Adopt relational metadata" in text
    assert f"/commit/{duplicate}" not in text and "(#44)" not in text
    # The merge is the only commit announcing this breaking change, so it remains visible.
    assert f"/commit/{merge_only}" in text and "Move instance settings (#45)" in text
    assert f"/commit/{settings}" in text
    # Breaking headers without a footer have no migration note to repeat.
    assert "> adopt relational metadata" not in text
    assert "> move instance settings (#45)" not in text


def test_maintenance_only_release_has_explicit_empty_notes(repository, tmp_path):
    repository("feat: add canvas", "0.1.0", "v0.1.0")
    repository("chore: prepare release", "0.1.1", "v0.1.1")
    notes = tmp_path / "notes.md"
    release.prepare_release("v0.1.1", "example/duckpad", notes)
    assert "No user-facing changes in this release." in notes.read_text()
