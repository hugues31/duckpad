"""Keep AI assistants and bots out of the commit co-authors GitHub credits as contributors."""

from __future__ import annotations

import os
import re
import subprocess

CO_AUTHOR = re.compile(r"^\s*co-authored-by:\s*(.+?)\s*$", re.IGNORECASE | re.MULTILINE)
# Match addresses, not names: a person called Claude may still be credited.
NON_HUMAN_EMAIL = re.compile(
    r"[^@\s]+@(?:anthropic\.com|multica\.ai)"
    r"|(?:\d+\+)?(?:claude|multica-agent|copilot|[\w.-]+\[bot\])@users\.noreply\.github\.com",
    re.IGNORECASE,
)


def non_human_co_authors(message: str) -> list[str]:
    # Squash merges concatenate commit messages, so trailers can also sit mid-body.
    return [
        co_author
        for co_author in CO_AUTHOR.findall(message)
        if NON_HUMAN_EMAIL.fullmatch(co_author.rpartition("<")[2].rstrip(">"))
    ]


def check(commits: list[tuple[str, str]]) -> None:
    problems = []
    for sha, message in commits:
        subject = message.partition("\n")[0]
        problems += [
            f"{sha[:12]} {subject}: Co-authored-by: {co_author}"
            for co_author in non_human_co_authors(message)
        ]
    if problems:
        raise ValueError(
            "Co-authored-by trailers credit people, not AI assistants or bots. "
            "Remove them from these commits and force-push the branch:\n" + "\n".join(problems)
        )


def commits(base: str) -> list[tuple[str, str]]:
    revisions = [f"{base}..HEAD"] if base and set(base) != {"0"} else ["-1", "HEAD"]
    log = subprocess.check_output(["git", "log", "-z", "--format=%H%n%B", *revisions], text=True)
    records = (record.partition("\n") for record in log.split("\0") if record)
    return [(sha, message) for sha, _, message in records]


def main() -> None:
    check(commits(os.environ.get("BASE_SHA", "")))
    print("Commit trailer policy passed")


if __name__ == "__main__":
    main()
