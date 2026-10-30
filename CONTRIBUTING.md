# Contributing to Duckpad

Thank you for helping improve Duckpad. Bug reports, documentation fixes and pull requests are welcome.

## Set up a development environment

You need Python 3.11+, Git, [uv](https://docs.astral.sh/uv/) and Node.js 20+.

```sh
bash scripts/setup.sh
uv run duckpad start --home .duckpad-dev --no-browser
```

`scripts/setup.sh` installs the Python dependencies (including the `dev` group) and builds the frontend. For frontend work, run `npm run dev --prefix frontend`; it proxies `/api` to the backend on port 8765.

## Code layout

- `src/duckpad` is the Python service. [The architecture guide](docs/ARCHITECTURE.md) describes each module, when modules form a sub-package, and the execution invariants.
- [Instance persistence](docs/PERSISTENCE.md) describes the SQLModel schema, transaction boundaries and Alembic migration workflow.
- `frontend/src` is the React interface. `api.ts` is the only HTTP client, `routes.tsx` renders the components of `pages/`, and `shell.ts` and `worktree.tsx` hold the session and working branch state they share.
- `tests` holds the Python suite; shared builders and waits live in `tests/helpers.py`.
- `frontend/e2e` holds the Playwright scenarios; `e2e/helpers.ts` signs in to the disposable test instance.
- `website` is the static Astro presentation and documentation site. See the
  [website guide](docs/WEBSITE.md) for its Node.js requirement, local preview,
  Playwright demo recording and publishing. Update the relevant guide and captured
  media when changing a demonstrated workflow; CI regenerates them before publishing.

## Run the checks

Run the same checks as CI before opening a pull request:

```sh
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run pytest -q
npm run check --prefix frontend
npm run lint --prefix frontend
npm run format:check --prefix frontend
npm run build --prefix frontend
npm run test:e2e --prefix frontend
```

Use `uv run ruff format src tests scripts` and `npm run format --prefix frontend` to fix formatting. Add a regression test with every bug fix: a Python test for service behavior, a Playwright scenario for interface behavior.

## Conventions

- Write code, comments, documentation, identifiers and commit messages in English. French and Portuguese are only used for values in `frontend/src/locales/fr.json` and `frontend/src/locales/pt.json`; add every new interface string to every locale file.
- Use [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(editor): preserve selection when saving`. Release notes are generated from them.
- Keep changes focused, and update the documentation in `docs/` when behavior changes.
- Never commit credentials, personal data or details of a private deployment.

## Report a vulnerability

Do not open a public issue for security problems; follow the [security policy](SECURITY.md).
