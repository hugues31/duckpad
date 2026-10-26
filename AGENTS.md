# Repository Instructions

Before modifying files or preparing commits in this repository, read and follow
[the repository-conventions skill](.agents/skills/repository-conventions/SKILL.md).
Apply it to every change, even when it is not explicitly invoked.

- Write repository content in English, except localized UI values in dedicated
  translation resource files, where French is allowed. Keep translation keys,
  file names, code, comments, and documentation in English.
- Use Conventional Commits for every commit message, written in English.

## Multica development

Follow [the Multica workflow](docs/MULTICA.md) for issues handled through Multica.
Use a dedicated branch and pull request for every issue, deploy and verify its
preview, then wait for Hugues's explicit approval before merging into `main` and
publishing the merge to GitHub. Never interpret ticket creation or a successful
check as merge approval. Use `bash scripts/preview.sh` for Duckpad previews.
