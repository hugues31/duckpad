# Contributing to Duckpad

Bug reports, documentation fixes and pull requests are welcome.

## Set up a development environment

You need Python 3.11+, Git, [uv](https://docs.astral.sh/uv/) and Node.js 20+.

```sh
bash scripts/setup.sh
uv run duckpad start --home .duckpad-dev --no-browser
```

`scripts/setup.sh` installs the Python dependencies (including the `dev` group) and builds the frontend. For frontend work, run `npm run dev --prefix frontend`; it proxies `/api` to the backend on port 8765.

## Code layout

- `src/duckpad` is the Python service. [The architecture guide](docs/ARCHITECTURE.md) maps its modules and execution invariants. Modules stay flat by default. A sub-package groups a family of implementations (`trace/`, `migrations/`) or a subsystem reached through a few entry points (`git/`); a shared file name prefix such as `git_` signals a missing sub-package. A package's `__init__.py` documents it and re-exports at most a small entry point.
- [Instance persistence](docs/PERSISTENCE.md) describes the SQLModel schema, transaction boundaries and Alembic migration workflow.
- `frontend/src` is the React interface. `api.ts` is the only HTTP client, `routes.tsx` renders the components of `pages/`, and `shell.ts` and `worktree.tsx` hold the session and working branch state they share.
- `frontend/src/styles` holds the global stylesheets, one file per zone of the interface. `styles/index.css` imports them in cascade order, and only `main.tsx` imports it. Add a new style to the file of its zone; add a new file to `styles/index.css`, never as an import from a component.
- `tests` holds the Python suite; shared builders and waits live in `tests/helpers.py`.
- `frontend/e2e` holds the Playwright scenarios; `e2e/helpers.ts` signs in to the disposable test instance.
- Vitest unit tests sit next to the frontend helpers and hooks they cover, as `frontend/src/*.test.ts` or `*.test.tsx`.
- `website` is the static Astro presentation and documentation site. See the
  [website guide](docs/WEBSITE.md) for its Node.js requirement, local preview,
  Playwright demo recording and publishing. Update the relevant guide and captured
  media when changing a demonstrated workflow; CI regenerates them before publishing.

## Run the checks

Run the same checks as CI before opening a pull request:

```sh
uv run ruff check src tests scripts
uv run ruff format --check src tests scripts
uv run ty check
uv run python scripts/check_typing_policy.py
uv run pytest -q
npm run check --prefix frontend
npm run lint --prefix frontend
npm run format:check --prefix frontend
npm run test:unit --prefix frontend
npm run build --prefix frontend
npm run test:e2e --prefix frontend
```

CI runs pytest on four processes with `-n 4 --dist worksteal`; add these options for a faster local run. Use `uv run ruff format src tests scripts` and `npm run format --prefix frontend` to fix formatting. Cover meaningful behavior at the narrowest useful level: Python for service behavior, Vitest for frontend logic, Playwright for browser interactions. Extend an existing regression test when possible; avoid duplicating it across layers or asserting incidental wording, CSS values or internal structure.

CI also runs the Python suite from the extracted source archive. A script or file read by a test must be listed in the sdist `include` of `pyproject.toml`. To reproduce that check after building the frontend:

```sh
uv build
archive_tests="$(mktemp -d)"
tar -xzf dist/duckpad-*.tar.gz --strip-components=1 -C "$archive_tests"
(
    export PATH="$PWD/.venv/bin:$PATH"
    cd "$archive_tests"
    PYTHONPATH="$PWD/src" python -m pytest -q
)
```

## Conventions

- Write code, comments, documentation, identifiers and commit messages in English. French and Portuguese are only used for values in `frontend/src/locales/fr.json` and `frontend/src/locales/pt.json`; add every new interface string to every locale file.
- Use [Conventional Commits](https://www.conventionalcommits.org/), for example `fix(editor): preserve selection when saving`. Release notes are generated from them.
- Keep changes focused. Update the relevant guide when usage changes; describe current behavior and remove superseded explanations. Git history preserves completed proposals and past implementations.
- Never commit credentials, personal data or details of a private deployment.

## Report a vulnerability

Do not open a public issue for security problems; follow the [security policy](SECURITY.md).
