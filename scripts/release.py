"""Validate an immutable release tag and render its Conventional Commit notes."""

import argparse
import json
import os
import re
import subprocess
import tomllib
from pathlib import Path

NUMBER = r"(?:0|[1-9][0-9]*)"
STABLE_TAG = rf"v{NUMBER}\.{NUMBER}\.{NUMBER}"
RELEASE_TAG = re.compile(rf"{STABLE_TAG}(?P<pre>(?:a|b|rc){NUMBER})?")
CONFIG = Path(__file__).resolve().parents[1] / "cliff.toml"


def git(*args):
    return subprocess.check_output(["git", *args], text=True).strip()


def validate_tag(tag):
    match = RELEASE_TAG.fullmatch(tag)
    if not match:
        raise ValueError(
            "Use vMAJOR.MINOR.PATCH, optionally followed by aN, bN, or rcN (for example v1.2.0rc1)."
        )
    version = tag[1:]
    project = tomllib.loads(Path("pyproject.toml").read_text())["project"]
    if project["version"] != version:
        raise ValueError(f"Tag version {version} does not match pyproject.toml version {project['version']}.")
    if git("rev-parse", f"refs/tags/{tag}^{{commit}}") != git("rev-parse", "HEAD"):
        raise ValueError("The release tag must point to the checked-out commit.")
    if subprocess.run(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"]).returncode:
        raise ValueError("Release tags must point to a commit already merged into origin/main.")
    return version, bool(match["pre"])


def omit_duplicate_breaking_merges(releases):
    """Drop breaking merge summaries whose merged branch already lists a breaking change.

    Breaking merge commits bypass the merge filter so their migration notes are never
    hidden. When the merged branch carries its own breaking commit in the same release,
    the merge summary would only repeat it.
    """
    for release in releases:
        breaking = {commit["id"] for commit in release["commits"] if commit["breaking"]}
        release["commits"] = [
            commit
            for commit in release["commits"]
            if not (commit["breaking"] and commit["merge_commit"])
            or breaking.isdisjoint(git("rev-list", f"{commit['id']}^1..{commit['id']}^2").split())
        ]
    return releases


def prepare_release(tag, repository, output):
    version, prerelease = validate_tag(tag)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("Repository must use the owner/name form.")
    cliff = ["git-cliff", "--config", str(CONFIG), "--offline", "--no-exec"]
    env = {**os.environ, "RELEASE_REPOSITORY": repository}
    # Include only stable tags and this tag, so stable releases and release
    # candidates both describe all changes since the previous stable release.
    context = subprocess.run(
        [*cliff, "--tag-pattern", rf"^(?:{STABLE_TAG}|{re.escape(tag)})$", "--current", "--context"],
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        text=True,
    ).stdout
    subprocess.run(
        [*cliff, "--from-context", "-", "--output", str(output)],
        input=json.dumps(omit_duplicate_breaking_merges(json.loads(context))),
        env=env,
        check=True,
        text=True,
    )
    if os.environ.get("GITHUB_OUTPUT"):
        with Path(os.environ["GITHUB_OUTPUT"]).open("a") as stream:
            stream.write(f"version={version}\nprerelease={str(prerelease).lower()}\n")
    return version, prerelease


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("tag")
    parser.add_argument("--repository", default="hugues31/duckpad")
    parser.add_argument("--output", type=Path, default=Path("release-notes.md"))
    args = parser.parse_args()
    try:
        version, prerelease = prepare_release(args.tag, args.repository, args.output)
    except (ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release validation failed: {error}\n")
    print(f"Prepared Duckpad {version} (prerelease={str(prerelease).lower()}).")


if __name__ == "__main__":
    main()
