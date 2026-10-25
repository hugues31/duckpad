# Architecture

Duckpad is one local Python process serving a compiled React application. FastAPI exposes authenticated management endpoints; React Flow handles graph interaction; Monaco handles SQL and JSON editing. DuckDB executes SQL and retains live materialized data. Git owns project code history. SQLite owns instance metadata. These stores have separate lifecycles.

## Modules

| Module | Responsibility |
| --- | --- |
| `app.py`, `auth.py`, `cli.py` | HTTP API, persistent salted password hash and session hashes, localhost startup, process lease |
| `store.py`, `catalog.py` | SQLite records, environments, reusable connections, typed connector setup and secret redaction |
| `projects.py` | Declarative files, Git worktrees, revision capture, three-way merge, durable conflict proposals, external-save batching |
| `templates.py`, `components.py` | Typed SQL compilation, read/write contracts, recursive expansion, parameter exposure, independent imports |
| `engine.py`, `materialize.py` | Admission, immutable execution configuration, DuckDB ownership, cancellation, output publication and invalidation |
| `lineage.py` | SQLGlot resolution and targeted provenance queries over materialized dependencies |
| `example.py` | Reproducible local sample data and documented Northstar project |

## Files and data

An instance contains `instance.sqlite`, a private extension cache, `projects/`, separate `worktrees/`, uploads, example source files and `exports/<worktree>/<environment>/`. The database file is created with mode 0600 and the instance directory with mode 0700. Secrets are instance configuration; no project file contains resolved credentials. The SQLite authentication record contains an scrypt hash and salt, never the generated password. Sessions are stored as hashes.

Each project repository versions `flow.json`, `documentation.json`, `templates/*.sql`, and `components/*.json`. Results, source data and export files are outside that versioned definition set. Connector definitions and environment settings have no configuration-version history. Historical project code always uses the current instance catalog when explicitly run.

## Save and capture

A UI save carries a content revision. Three-way comparison uses that base, the current files (including pending external edits), and the proposal. Stable-ID objects and disjoint JSON fields merge; incompatible SQL/file changes become recoverable conflicts. Conflicts retain all three versions in SQLite. Resolution rechecks the current files before writing. A metadata-only conflict does not block computation; a computation conflict blocks dependent scopes, conservatively the whole graph if unreadable.

A worktree watcher samples relevant files and closes a batch after 500 ms of inactivity. Two saves 300 ms apart form one save unit. Invalid final files are committed and diagnosed; an intermediate invalid write corrected within the batch is not separately committed. UI commits suppress duplicate watcher commits. A manual launch finalizes pending changes and reads the committed files through `git archive`, so its commit and captured definitions agree.

Display metadata, layout and documentation are excluded from computation fingerprints. A change in SQL, parameters, input edges or connection setup invalidates the dependent scope in the affected environment. No edit executes SQL automatically.

## Execution service

`Engine.launch(worktree, environment, target, entry_point)` is the shared service. HTTP callers record `manual` origin and `ui` or `api` entry point. A lock reserves a worktree before preparation. Busy requests receive 409; no task is queued. Reservation spans preparation, execution, cancellation and cleanup, across all environments in that worktree. Other worktrees can run independently.

Accepted runs capture project code, parameters, graph, environment and resolved connection settings. A worker thread owns its DuckDB cursor. Every requested ancestor runs once in topological order, including valid sources. Independent branches continue after a node failure; failed descendants are blocked. Connection preparation is lazy within that immutable run and each logical connection is prepared once. Oracle attachments are recreated on the next manual run.

Outputs are staged under fresh physical names and published together only after all blocks succeed. A failed or canceled node keeps its previous successful output set as stale. No downstream node uses that set as a fallback. Publication rechecks computation fingerprints, so an edit during a run cannot make outdated results appear valid.

A stop request sets a cancellation token and calls `interrupt()` on the active cursor. No later node starts. The worktree stays reserved until the operation and cleanup finish. External effects obey DuckDB and the extension: completed writes remain completed, and interrupted writes can have unknown or partial effects. Shutdown requests cancellation and waits for workers before closing their databases.

Run records are persisted at admission and at each node/status transition, including SQL, timings, sanitized connection snapshots, code definitions and observed write outcomes. On restart, unfinished records become interrupted; no computation or export is replayed. In-memory result tables are not persisted.

## Lineage concurrency

Public views contain exactly the query's original columns. Private tables hold stable row identities and, where safe, hidden input witnesses or grouping keys. Deterministic native-equivalence tests compare values, types and multiplicities against DuckDB without instrumentation. Uncovered SQL remains executable; exploration reports limitations explicitly.

A lineage request registers its result generation and dependency nodes. Recalculation marks affected generations stale, interrupts their lineage cursors, rejects new requests and waits for canceled readers to relinquish the old tables before retiring them. Unrelated requests remain active. The browser validates the selected generation and discards late responses; it never automatically follows an old row into a new result.

## HTTP surface

All `/api` routes except login require a session cookie or bearer session token. Mutation requests reject a mismatched browser Origin. The static login shell is public; project content is authenticated.

The main endpoint groups are `/projects`, `/worktrees`, `/catalog`, `/environments`, `/runs`, `/conflicts`, `/library`, and `/uploads`. A worktree exposes definition snapshots and saves, branch/merge history, compiled SQL, status, previews, lineage and manual run launch. See the route definitions in `src/duckpad/app.py` for request shapes. APIs use the same services as the interface; there is no second runner or separate editor state.
