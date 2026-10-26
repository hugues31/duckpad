# Multica development and previews

The Duckpad project is available in the `general` workspace at
<https://multica.example.invalid>. Assign development issues to
**Dev - Astra XHigh**, which uses the Codex runtime on `preview-host`.
The server checkout is `/home/preview-user/duckpad` and the repository is
<https://github.com/hugues31/duckpad>.

## Issue workflow

1. Read the issue, this guide, and `AGENTS.md`. Fetch `origin` and start a dedicated
   `codex/<issue-id>-<short-description>` branch from `origin/main` in an isolated
   worktree. Reuse the worktree allocated by Multica when available. Continue the
   existing issue branch for review follow-ups.
2. Run `bash scripts/setup.sh` in each new worktree. Implement the requested change
   and run the relevant checks from the README.
3. Commit with an English Conventional Commit message, push the issue branch to
   GitHub, and open a pull request targeting `main`.
4. Deploy using `bash scripts/preview.sh deploy <issue-id-in-lowercase>`. This
   configures the shared Coolify helper for the Dockerfile and port 8765. Do not
   invoke the helper with its default Node/Nixpacks settings.
5. Check that the Coolify deployment has **finished** for the expected Git commit.
   A working URL can still be serving the previous deployment during a rebuild.
   Confirm the public frontend, sign-in, and the changed behavior in a browser.
6. Post the preview URL, PR link, tested commit, validation results, and a short
   change summary in the issue. Set the issue to `in_review` and stop.
7. Merge **only after Hugues explicitly approves that issue's current changes** in
   the ticket or PR. Opening a ticket, a successful build, an automated review,
   or an `in_review` status is not approval. Further requested changes must be
   committed, pushed, redeployed, and reviewed again.
8. After approval, fetch current `main`, resolve conflicts if needed, rerun relevant
   checks, and merge the PR into GitHub `main`. Use an English Conventional Commit
   merge/squash title. Verify that the approved changes are present on
   `origin/main`; never force-push `main`.
9. Only after the merge succeeds, destroy the ticket preview with
   `bash scripts/preview.sh destroy <issue-id-in-lowercase>`, report the merge in
   the issue, and mark it done. Also destroy previews for cancelled issues.

The initial application is already on `main`. Preview setup corrections are
reviewed separately in `codex/multica-preview`; merge them only after approval.

## Preview infrastructure

The server has an isolated Node.js 22 installation and `uv`; load them before
running development commands (the setup script also does this automatically):

```sh
export PATH="$HOME/.local/share/duckpad-tools/node/bin:$HOME/.local/bin:$PATH"
```

The server's Ivy Bridge CPU cannot load the published DuckDB 2.0 wheel. Docker
and `scripts/setup.sh` build the locked DuckDB version from source for baseline
x86-64, with two compiler jobs to limit memory usage. The first build is slow;
subsequent worktrees and previews reuse the uv/Docker build caches. Development
uses Python 3.12, installed by uv when needed. Do not replace DuckDB with 1.x.

Previews are Coolify applications in the existing `preview-project` project.
Their URL is `https://<issue-id>.app.example.invalid`. The server's nginx
terminates HTTPS and forwards to Coolify's Traefik proxy; the Coolify application
domain intentionally uses `http://`. No extra public application port is needed.

The helper is installed at
`/home/preview-user/.claude/skills/coolify-preview/preview.sh`. Authentication comes from
`COOLIFY_TOKEN` or the server's private `~/.coolify/multica-token` file. The
repository wrapper selects the existing private-repository GitHub App. Never
commit tokens, instance data, or preview passwords, or include them in tickets.

The Docker image builds React and installs the locked Python dependencies, then
runs the application as an unprivileged user. Each preview has its own generated
`admin` password and disposable data under `/data/duckpad`. Redeploying or deleting
a preview can reset both. Use synthetic example data in previews. An installation
that must preserve data needs a persistent volume owned by UID/GID 10001.

Retrieve the initial password privately from the application's runtime logs in
Coolify. The setup preview's initial credentials are also saved on the server in
`~/.config/duckpad/preview-credentials.json` with owner-only permissions.
Passwords are generated on first launch and are not baked into the image.

```sh
bash scripts/preview.sh status mul-123
python3 scripts/verify_preview.py https://mul-123.app.example.invalid
```

The baseline setup preview is <https://duckpad.app.example.invalid>. It is for
reviewing the initial implementation/setup and should be removed after that
review; future tickets receive separate URLs.
