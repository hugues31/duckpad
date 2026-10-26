# Architecture

Duckpad has a Python API process serving a compiled React application and isolated SQL worker processes. FastAPI exposes authenticated management endpoints; React Flow handles graph interaction; Monaco handles SQL and JSON editing. DuckDB executes SQL and retains live materialized data. Git owns project code history. SQLite owns instance metadata. These stores have separate lifecycles.

## Modules

| Module | Responsibility |
| --- | --- |
| `app.py`, `schemas.py`, `auth.py`, `access.py`, `cli.py` | HTTP API and request bodies, individual accounts, salted password hashes, owned sessions and instance/project authorization, localhost startup, process lease |
| `services.py` | Wiring of the instance services shared by the API, tests and scripts |
| `store.py`, `catalog.py` | SQLite records, environments, reusable connections, typed connector setup and secret redaction |
| `projects.py`, `bundle.py`, `merge.py` | Git worktrees, revision capture, external-save batching and durable conflict proposals; declarative file layout and validation; three-way merge |
| `templates.py`, `builtin_templates.py`, `components.py` | Typed SQL compilation, read/write contracts, built-in templates, recursive expansion, parameter exposure, independent imports |
| `engine.py`, `datasets.py`, `materialize.py` | Admission, immutable execution configuration, DuckDB ownership, cancellation, output publication and invalidation |
| `lineage.py`, `trace.py`, `sqlast.py` | Lineage requests and their cancellation; SQLGlot normalization and targeted provenance queries over materialized dependencies |
| `sandbox.py`, `sql_worker.py` | JSON RPC, separate SQL processes, kernel filesystem restrictions and locked DuckDB configuration |
| `resources.py` | Portable process CPU and memory counters, including visible container limits |
| `example.py` | Reproducible local sample data and documented Northstar project |

The frontend in `frontend/src` mirrors this split: `api.ts` is the only HTTP client, `App.tsx` owns the workspace state, and each page, panel and dialog has its own module.

## Files and data

An instance contains `instance.sqlite`, a private extension cache, `projects/`, separate `worktrees/`, uploads, example source files and `exports/<worktree>/<environment>/`. The database file is created with mode 0600 and the instance directory with mode 0700. Secrets are instance configuration; no project file contains resolved credentials. SQLite user records contain scrypt hashes and salts, never plaintext passwords. Sessions are stored by token hash, identify their owner and expire after seven days. A session also records the credential and revocation version; resetting a password or deactivating an account invalidates its sessions, including after reactivation.

Each project repository versions `flow.json`, `documentation.json`, `templates/*.sql`, and `components/*.json`. Results, source data and export files are outside that versioned definition set. Connector definitions and environment settings have no configuration-version history. Historical project code always uses the current instance catalog when explicitly run.

## Save and capture

A UI save carries a content revision. Three-way comparison uses that base, the current files (including pending external edits), and the proposal. Stable-ID objects and disjoint JSON fields merge; incompatible SQL/file changes become recoverable conflicts. Conflicts retain all three versions in SQLite. Resolution rechecks the current files before writing. A metadata-only conflict does not block computation; a computation conflict blocks dependent scopes, conservatively the whole graph if unreadable.

A worktree watcher samples relevant files and closes a batch after 500 ms of inactivity. Two saves 300 ms apart form one save unit. Invalid final files are committed and diagnosed; an intermediate invalid write corrected within the batch is not separately committed. UI commits suppress duplicate watcher commits. A manual launch finalizes pending changes and reads the committed files through `git archive`, so its commit and captured definitions agree.

Display metadata, layout and documentation are excluded from computation fingerprints. A change in SQL, parameters, input edges or connection setup invalidates the dependent scope in the affected environment. No edit executes SQL automatically.

## Execution service

`Engine.launch(worktree, environment, target, entry_point)` is the shared service. HTTP callers record `manual` origin and `ui` or `api` entry point. A lock reserves a worktree before preparation. Busy requests receive 409; no task is queued. Reservation spans preparation, execution, cancellation and cleanup, across all environments in that worktree. Other worktrees can run independently.

Accepted runs capture project code, parameters, graph, environment and resolved connection settings. A coordinator thread owns a cursor proxy in the isolated SQL worker. Every requested ancestor runs once in topological order, including valid sources. Independent branches continue after a node failure; failed descendants are blocked. HTTP execution initializes only project-authorized connections before locking the worker configuration. Changes to connection configuration or grants require idle executions and discard affected workers and cached results. Trusted in-process service clients without an `Access` policy retain lazy connection preparation; the HTTP application always supplies the policy.

Outputs are staged under fresh physical names and published together only after all blocks succeed. A failed or canceled node keeps its previous successful output set as stale. No downstream node uses that set as a fallback. Publication rechecks computation fingerprints, so an edit during a run cannot make outdated results appear valid.

A stop request sets a cancellation token and calls `interrupt()` on the active cursor. No later node starts. The worktree stays reserved until the operation and cleanup finish. External effects obey DuckDB and the extension: completed writes remain completed, and interrupted writes can have unknown or partial effects. Shutdown requests cancellation and waits for workers before closing their databases.

Run records are persisted at admission and at each node/status transition, including SQL, timings, sanitized connection snapshots, code definitions and observed write outcomes. On restart, unfinished records become interrupted; no computation or export is replayed. In-memory result tables are not persisted.

### Scheduling decision

The MVP uses the embedded execution service without a scheduler or persistent task queue. A completed comparison with SqliteHuey selected APScheduler 3.x as the preferred future scheduling adapter. Queue persistence does not replace worktree admission, live result contexts or durable run history, and consuming queued work after a restart would require an explicit policy for replaying external writes. Neither scheduling library is a current dependency; the prototype and its report remain in Git history.

Future schedule and webhook handlers must submit worktree, environment, scope and trigger identity through the same execution service. They must capture fresh configuration, keep connections and credentials out of trigger payloads, and reject occupied worktrees without deferring the request. Before enabling automation, define time zones and DST, missed occurrences, rejected-trigger outcomes, webhook authentication and idempotency, and retention policies. Schedules, webhooks, retries and missed-run replay are not enabled in the MVP.

## Lineage concurrency

Public views contain exactly the query's original columns. Private tables hold stable row identities and, where safe, hidden input witnesses or grouping keys. Deterministic native-equivalence tests compare values, types and multiplicities against DuckDB without instrumentation. Uncovered SQL remains executable; exploration reports limitations explicitly.

A lineage request registers its result generation and dependency nodes. Recalculation marks affected generations stale, interrupts their lineage cursors, rejects new requests and waits for canceled readers to relinquish the old tables before retiring them. Unrelated requests remain active. The browser validates the selected generation and discards late responses; it never automatically follows an old row into a new result.

## HTTP surface

All `/api` routes except login require a session cookie or bearer session token. Mutation requests reject a mismatched browser Origin. The static login shell is public; project content is authenticated.

The main endpoint groups are `/session`, `/workspace`, `/identity`, `/projects`, `/example`, `/worktrees`, `/catalog`, `/environments`, `/runs`, `/conflicts`, `/library`, `/users`, `/password` and `/resources`. Uploads use `/worktrees/{id}/uploads` and are stored under `resources/<project>/`. Request bodies are validated; invalid requests receive a 422 response in the same `{"error", "detail"}` format as other failures. A worktree exposes definition snapshots and saves, branch/merge history, compiled SQL, status, previews, lineage and manual run launch. See the route definitions in `src/duckpad/app.py` for request shapes. APIs use the same services as the interface; there is no second runner or separate editor state.

## Authorization and execution isolation

The server rechecks the account, instance role and project membership on every
request. Invisible projects and their worktrees, runs and conflicts return 404.
Readers may inspect existing results and lineage, but cannot launch computation,
change files, create branches, import definitions, cancel runs or upload files.
Imports also require read access to their source project. Workspace, library and
execution lists filter private resources before returning them. Last-admin checks
and membership/account writes share a lock, including concurrent demotions.

SQL runs in a separate process per worktree/environment. The worker receives only
the project's authorized connection configuration and communicates through a
JSON-only protocol. It does not inherit the API's environment credentials or
SQLite descriptors. Before DuckDB creates threads, Linux Landlock restricts file
access to project resources/exports, explicit administrator-authorized local roots,
and read-only runtime libraries. Project Git metadata, other projects and instance
SQLite remain outside the data allowlist. Traversal and symlink escapes are denied
by the kernel. DuckDB external access is then disabled with explicit allowed paths;
auto-installation/loading of extensions and unredacted/persistent secrets are
disabled, and its configuration is locked before user SQL executes.

This requires Landlock ABI 2+ on Linux x86-64 or arm64, including inside containers.
A missing or blocked sandbox causes an explicit execution error; there is no
unrestricted fallback. Workers use two DuckDB threads and a 512 MB memory limit.
Connection extensions remain trusted administrator-installed code. Approved remote
connections carry the privileges of their configured service credentials; operators
must scope those credentials and any network egress policy accordingly. This does
not provide tenant resource quotas or a complete hostile-code hosting boundary.
See the [DuckDB security guidance](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)
and [Linux Landlock API](https://docs.kernel.org/userspace-api/landlock.html).

The default local connection covers only each project's resources and exports.
Additional local roots must exist and exclude the instance directory, its ancestors
and other projects. Legacy unrestricted paths require explicit connection roots;
existing results are not recomputed during migration or read requests. Sample
projects receive their own input directories and connection grants. Users may
upload source files from the node inspector. Read-only roots stay read-only at the
OS layer even if SQL uses a different declared connection.
