# Repository Instructions

Before modifying files or preparing commits in this repository, read and follow
[the repository-conventions skill](.agents/skills/repository-conventions/SKILL.md).
Apply it to every change, even when it is not explicitly invoked.

- Write repository content in English, except localized UI values in dedicated
  translation resource files, where French and Portuguese are allowed. Keep
  translation keys, file names, code, comments, and documentation in English.
- Use Conventional Commits for every commit message, written in English.

## Multica development

Follow the operator's Multica workflow guide for issues handled through Multica.
That guide (`docs/MULTICA.md`) and the preview wrapper (`scripts/preview.sh`) are
not part of this repository: Git ignores them and `main` does not contain them.
Use the copies in the operator's private server checkout; the Multica project
settings give its location and the preview deployment command.

Use a dedicated branch and pull request for every issue, deploy and verify its
preview, then wait for the designated human reviewer's explicit approval before
merging into `main` and publishing the merge to GitHub. Never interpret ticket
creation or a successful check as merge approval.

Keep private infrastructure details outside this public repository. Never include
personal domains, preview URLs, server names, deployment identifiers, or credentials
in tracked files, commits, GitHub pull requests, or public build output. Share
preview URLs only in the private Multica issue; retrieve deployment configuration
from the operator's private environment. Do not include credentials in tickets.
