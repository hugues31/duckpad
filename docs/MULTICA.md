# Multica development and previews

Configure a Multica project with a Git repository, a local checkout resource using
isolated worktrees, a development agent, and a designated human reviewer. Keep
instance URLs, server paths, resource identifiers, and credentials in private
project settings and operator configuration, outside this public repository.

## Issue workflow

1. Read the issue, this guide, and `AGENTS.md`. Fetch `origin` and start a dedicated
   branch from `origin/main` in an isolated worktree. Reuse Multica's allocated
   issue branch and worktree when available; otherwise name the branch
   `codex/<issue-id>-<short-description>`. Reuse that branch for review follow-ups.
2. Run `bash scripts/setup.sh`, implement the change, and run the relevant checks
   from the README.
3. Commit with an English Conventional Commit message, push the issue branch to
   GitHub, and open a pull request targeting `main`.
4. Deploy using `bash scripts/preview.sh deploy <issue-id-in-lowercase>`. The wrapper
   selects the Dockerfile and port 8765, then waits for Coolify to finish deploying
   the exact pushed commit. Confirm sign-in and the changed behavior in a browser.
5. Post the preview URL, PR link, tested commit, checks, and change summary in the
   **private Multica issue only**. Keep preview URLs and private infrastructure
   details out of GitHub PRs, commits, documentation, and public logs. Set the issue
   to `in_review` and stop.
6. Merge only after the designated human reviewer explicitly approves the current
   changes. A human can move the ticket to **Approved to merge** to trigger this
   step, or back to **Todo** for rework. Agents must never approve their own work.
   Ticket creation, successful checks, automated reviews, and `in_review` status
   are not approval. Further changes require another deployment and review.
7. After approval, fetch current `main`, resolve conflicts, rerun relevant checks,
   and merge the PR into GitHub `main`. Use an English Conventional Commit title.
   Verify the approved changes are present on `origin/main`; never force-push it.
8. After a successful merge, destroy the ticket preview with
   `bash scripts/preview.sh destroy <issue-id-in-lowercase>`, report the merge in the
   private issue, and mark it done. Also destroy previews for cancelled issues.

## Private deployment configuration

Install a trusted Coolify preview helper supporting `deploy <slug> <repository>
<branch>`, `status <slug>`, and `destroy <slug>`. Configure its project, server, and
preview domain privately. Applications must be named `preview-<slug>` and expose
HTTPS at `<slug>.<preview-domain>`.

The wrapper loads trusted shell configuration from
`${XDG_CONFIG_HOME:-$HOME/.config}/duckpad/preview.env`, or the path specified by
`DUCKPAD_PREVIEW_CONFIG`. Keep this file outside the checkout with owner-only
permissions. These are placeholders, not a working deployment:

```sh
COOLIFY_PREVIEW_HELPER="$HOME/.local/bin/coolify-preview"
COOLIFY_API_URL="https://coolify.example.invalid/api/v1"
DUCKPAD_PREVIEW_DOMAIN="preview.example.invalid"
COOLIFY_TOKEN_FILE="$HOME/.config/duckpad/coolify-token"
COOLIFY_GITHUB_APP_UUID="your-private-github-app-identifier"
```

The wrapper exports these values to the helper and verifier. Alternatively,
provide them as environment variables. `COOLIFY_TOKEN` can replace the token file.
The repository URL comes from `origin`; `DUCKPAD_REPOSITORY_URL` can override it.
Never commit real configuration, share credentials in tickets, or publish helper
output containing private infrastructure details.

```sh
bash scripts/preview.sh status issue-123
bash scripts/preview.sh verify issue-123
```

## Runtime provisioning

Keep DuckDB 2.0. Older x86-64 CPUs without AVX2 or BMI2 may not run published
DuckDB 2.0 binaries. Provision the compatible package and Docker base once with
`bash scripts/provision-runtime.sh`. This requires Python 3.11+, a C++ compiler,
uv, and Docker on a Debian-compatible build host. The script builds the locked
source with `DUCKDB_OPTIMIZATION_PROFILE=NONE` and baseline x86-64 compiler flags,
or reuses an existing validated wheel. Ticket previews do not rebuild DuckDB.

The validated wheel and checksum live under
`~/.local/share/duckpad-tools/wheels/2.0.0`. `scripts/setup.sh` installs it when
needed in each Python 3.12 worktree, and subsequent `uv sync` retains it. The
Dockerfile reuses `duckpad-python:3.12-duckdb2.0.0` on the Coolify build server.
Its `coolify.managed=true` label preserves it during automatic image cleanup.
Keep the image and wheel directory; update both together with the lockfile.

Setup also supports an isolated Node.js installation under
`~/.local/share/duckpad-tools/node`. Playwright can use normal OS dependencies or
libraries unpacked under `~/.local/share/duckpad-tools/browser-libs`, optionally
overridden with `DUCKPAD_BROWSER_LIBRARY_PATH`.

Preview containers run as UID/GID 10001, generate an initial admin password, and
use disposable data under `/data/duckpad`. Retrieve credentials privately from
runtime logs. Redeployment can reset data and credentials; use synthetic data.
Persistent installations require a volume owned by that user.

The preview image sets `DUCKPAD_SECURE_COOKIES=1` for HTTPS behind a TLS proxy.
For a container used exclusively on local HTTP, override it with `0`.
