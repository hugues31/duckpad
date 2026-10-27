# Repository Instructions

Before modifying files or preparing commits in this repository, read and follow
[the repository-conventions skill](.agents/skills/repository-conventions/SKILL.md).
Apply it to every change, even when it is not explicitly invoked.

- Write repository content in English, except localized UI values in dedicated
  translation resource files, where French is allowed. Keep translation keys,
  file names, code, comments, and documentation in English.
- Use Conventional Commits for every commit message, written in English.

## Multica development

Follow the operator-provided workflow for issues handled through Multica.
Use a dedicated branch and pull request for every issue, deploy and verify its
preview, then wait for the designated human reviewer's explicit approval before merging into `main` and
publishing the merge to GitHub. Never interpret ticket creation or a successful
check as merge approval. Use the operator-provided deployment tooling for previews.

Keep private infrastructure details outside this public repository. Never include
personal domains, preview URLs, server names, deployment identifiers, or credentials
in tracked files, commits, GitHub pull requests, or public build output. Share
preview URLs only in the private Multica issue; retrieve deployment configuration
from the operator's private environment. Do not include credentials in tickets.
