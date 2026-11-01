# Architecture

Duckpad has a Python API process serving a compiled React application and isolated SQL worker processes. FastAPI exposes authenticated management endpoints; React Flow handles graph interaction; Monaco handles SQL and JSON editing. DuckDB executes SQL and retains live materialized data. Git owns project code history. SQLite owns instance metadata. These stores have separate lifecycles.

## Modules

| Module | Responsibility |
| --- | --- |
| `app.py`, `schemas.py`, `auth.py`, `access.py`, `cli.py` | HTTP API and request bodies, individual accounts, salted password hashes, owned sessions and instance/project authorization, localhost startup, process lease |
| `assistant/` (`config.py`, `service.py`, `tools.py`, `editing.py`, `actions.py`, `runs.py`, `approvals.py`, `api.py`) | Write-only instance provider keys; author-owned SQLite conversations; one bounded Pydantic AI agent per turn; validated page context, permission-scoped reading/editing, persisted run approval, debugging, quick prompts and cancellable NDJSON streaming |
| `services.py` | Wiring of the instance services shared by the API, tests and scripts |
| `models.py`, `store.py`, `paths.py`, `migrations/`, `catalog.py` | SQLModel tables, Alembic migrations, transactions, the instance directory layout, environments, reusable connections and secret redaction |
| `projects.py`, `bundle.py`, `archive.py`, `merge.py` | Git worktrees, revision capture, external-save batching and durable conflict proposals; declarative file layout and validation; bounded project ZIP export and import; three-way merge |
| `git/` (`command.py`, `workspace.py`, `remote.py`, `credentials.py`, `identity.py`) | The only Git process runner: time-limited, without hooks or server Git configuration, logging Git output and returning readable errors; branches and reviewed merges; bounded fetch and leased push in an isolated Git and SSH environment; per-account SSH keys, trusted Git hosts and URL-bound consent; commit attribution of the current request |
| `templates.py`, `builtin_templates.py`, `components.py`, `graph.py` | Typed SQL compilation, read/write contracts, built-in templates, recursive expansion, parameter exposure, independent imports, dependency and connection queries over expanded flows |
| `extensions.py`, `project_extensions.py` | Instance binary imports and trust roots; portable extension requirements, local availability and loading checks |
| `variables.py` | Project variables: `variables.json` validation, parameter binding and expression references per environment, usages, renames and comparison values |
| `engine.py`, `execution/`, `datasets.py`, `materialize.py` | The engine facade over its services: run admission, immutable execution configuration, cancellation and output publication; the pool of DuckDB contexts and SQL workers; export results and their download copies; previews and compiled SQL; computation fingerprints and invalidation |
| `lineage.py`, `trace/`, `sqlast.py` | Lineage requests and their cancellation; SQLGlot normalization and targeted provenance queries over materialized dependencies, built as SQLGlot expressions by one visitor per SQL construct |
| `sandbox.py`, `sql_worker.py` | JSON RPC, separate SQL processes, kernel filesystem restrictions and locked DuckDB configuration |
| `resources.py` | Portable machine-wide CPU and physical memory counters |
| `example.py` | Reproducible local sample data and documented Northstar project |

Modules stay flat in `src/duckpad` by default. A sub-package groups either a family
of implementations of one construct, such as the `trace/` visitors and the
`migrations/` revisions, or a subsystem of several modules with its own vocabulary
that the rest of the code reaches through a few entry points, such as `git/`. A
shared file name prefix such as `git_` signals a missing sub-package, while modules
used throughout the code, such as `templates.py` or `util.py`, stay at the top
level. A package's `__init__.py` documents it and re-exports at most a small entry
point, as `trace/` does; callers otherwise import the module that defines a name.

The frontend in `frontend/src` mirrors this split: `api.ts` is the only HTTP client, `App.tsx` is the signed-in layout, `shell.ts` and `worktree.tsx` share the session and the open working branch with its pages, and each page, panel and dialog has its own module.

## Files and data

An instance contains `instance.sqlite`, a private extension cache, `projects/`, separate `worktrees/`, uploads, example source files and `exports/<worktree>/<environment>/`. The database file is created with mode 0600 and the instance directory with mode 0700. Secrets are instance configuration; no project file contains resolved credentials. SQLite user records contain scrypt hashes and salts, never plaintext passwords. Sessions are stored by token hash, identify their owner and expire after seven days. A session also records the credential and revocation version; resetting a password or deactivating an account invalidates its sessions, including after reactivation. Account SSH private keys, trusted Git host keys and origin consents are records of the same database; deactivating an account deletes its key. Network Git copies a key to a 0600 file under `git-network/` only for the duration of one operation; copies left by a crash are removed at startup.

Each project repository versions `flow.json`, `README.md`, `pyproject.toml`, `documentation.json`, `variables.json`, `extensions.json`, `templates/*.sql`, and `components/*.json`; `flow.json` and `documentation.json` are required. Project prose lives in `README.md`; node, output and column descriptions stay in `documentation.json`. The API combines them in `bundle.documentation` for UI editing and carries the manifest as raw `bundle.pyproject` text to preserve comments and custom settings. Older JSON project prose is read until a bundle save writes the new layout. Results, source data, virtual environments and export files are outside that versioned definition set. Connector definitions and environment settings have no configuration-version history. Historical project code always uses the current instance catalog when explicitly run.

## Settings scopes

Settings follow the same instance, project and user boundaries as authorization:

| Scope | Entry point | Settings and permissions |
| --- | --- | --- |
| Instance | **Instance settings** in the main navigation | User accounts and instance roles (member/admin), OIDC single sign-on, AI assistant providers/models and data policy, trusted Git hosts and origin prefixes, environment names, connections and connector definitions, DuckDB extension imports and unsigned policy, and SQL session threads and memory limits. Only instance administrators can configure these. |
| Project | **Project settings** in the open project's toolbar | Participants and project roles (reader/operator/editor/admin), authorized connections, and project deletion. Project administrators manage participants; only instance administrators grant access to instance connections. Readers, operators and editors can inspect their project's access without changing it. |
| Project definition | **Variables** and **Extensions** in the working branch | Versioned values and extension requirements; editors change them and readers inspect them. Extension installation and trust remain instance settings. |
| User | **Account menu → User settings** | Language, theme, the signed-in account's password and its SSH key for Git. SSO accounts manage their password with the identity provider. |

Instance configuration applies across projects. Selecting a branch or run
environment belongs to the pipeline workspace and does not edit that configuration.
Project membership assigns existing accounts; creating or deactivating an account
is an instance operation. Language and theme remain browser-local preferences,
shared by accounts using that browser, and are not synchronized between devices.
The account menu retains shortcuts for changing those preferences.

## Browser navigation

The browser URL selects the page, settings section, worktree, and workspace tab.
`routes.tsx` maps each route to a page component of `pages/`; `main.tsx` installs
React Router's `createBrowserRouter` and `RouterProvider`. `App.tsx` is the
persistent layout around the pages, with the top bar, dialogs and navigation guard.
Dialog state is plain data; each dialog builds its actions from the current state.
Page links use `Link` or `NavLink`, with browser history, keyboard navigation,
active states, and opening in another tab. Titles and focus follow page changes.

| URL | Destination |
| --- | --- |
| `/projects` | Project dashboard |
| `/instance-settings` | Instance general settings, for instance administrators |
| `/instance-settings/:section` | `users`, `sso`, `assistant`, `git-hosts`, `environments`, `connections` or `extensions` |
| `/user-settings` | Preferences and password for the signed-in account |
| `/projects/:projectId/jobs` | Jobs, version comparison, execution controls and result access |
| `/projects/:projectId/settings` | Project settings with role-specific controls |
| `/worktrees/:worktreeId/:tab` | Pipeline workspace: `flow`, `code`, `documentation`, `variables`, `extensions` or `history` |

After authentication, `/` redirects to `/projects`, except when completing a
validated SSO return. There is no worktree restoration from local storage. Unknown paths, sections, and tabs show a not-found
screen. Deleted or inaccessible resources show an unavailable screen with a link
to Projects. Backend authorization remains authoritative, including when access
changes during a session.

Worktree IDs identify branches without embedding branch names or filesystem
paths. The optional `?environment=dev` selects a configured run environment;
invalid names are replaced with the first configured environment. Changing the
environment participates in browser history. Navigation never starts, cancels,
or replays a pipeline run. Graph selection, panel sizes, modals, SQL drafts,
credentials, and result data stay out of URLs. Theme and language remain browser
preferences, and URL segments remain stable across translations.

Local sign-in and session expiry preserve the requested URL. OIDC still uses
its existing API callback and returns to `/`; the login page stores the validated
internal destination in tab-scoped session storage for that round trip. Only
known application paths and the environment selection are retained. External
return destinations are rejected, and existing SSO error handling is preserved.

Code drafts remain mounted across tabs within a worktree. `useBlocker` asks
before navigation that would discard code or documentation drafts, including
browser Back/Forward. Canceling keeps the edits; confirming discards them.
`beforeunload` protects reloads and document exits. Pending responses from an old
worktree cannot overwrite the current worktree's snapshot.

FastAPI serves the frontend shell for direct application requests through its
final fallback route. `/api` and `/api/*` retain authentication and API errors;
`/assets` and the optional `/site` website are mounted before the fallback.
Playwright covers navigation, authentication returns, history, draft protection,
permissions, and translations. HTTP tests verify direct-entry fallback and the
API, asset, and documentation boundaries.

## Assistant boundary

The assistant uses `pydantic-ai-slim` with only the OpenAI, Anthropic, Google and
Mistral extras (DeepSeek, Ollama and custom endpoints use the OpenAI transport).
Keys follow the OIDC write-only pattern and are retained only for the same
provider type and base URL. Each request owns its HTTP client and cancellation
token. Tool calls revalidate the session, project membership and configuration
revision; result tools also recheck connection grants. Editing tools reuse project
saves and inverse merges. Run tools require durable Pydantic AI deferred approval
and call the shared engine with current editor permissions. There is no arbitrary
SQL or network tool. `api.ts` owns the streaming HTTP client.

Alembic revision `0002_assistant` adds `assistant_conversation`, with cascading
foreign keys to the author and optional project. Its messages use Pydantic AI’s
`ModelMessagesTypeAdapter`; UI turns hold safe text and compact tool cards.
Ownership checks do not grant an instance-admin override. Concurrent turns in
one conversation return 409. Provider errors never echo SDK exception bodies.
Tests globally disable model requests and inject `TestModel` or `FunctionModel`;
only the disposable browser-test server injects a deterministic model.

## Save and capture

A UI save carries a content revision. Three-way comparison uses that base, the current files (including pending external edits), and the proposal. Stable-ID objects and disjoint JSON fields merge; incompatible SQL/file changes become recoverable conflicts. Conflicts retain all three versions in SQLite. Resolution rechecks the current files before writing. A metadata-only conflict does not block computation; a computation conflict blocks dependent scopes, conservatively the whole graph if unreadable.

A worktree watcher samples relevant files and closes a batch after 500 ms of inactivity. Two saves 300 ms apart form one save unit. Invalid final files are committed and diagnosed; an intermediate invalid write corrected within the batch is not separately committed. UI commits suppress duplicate watcher commits. A manual launch finalizes pending changes and reads the committed files through `git archive`, so its commit and captured definitions agree.

Display metadata, layout and documentation are excluded from computation fingerprints. A change in SQL, parameters, input edges or connection setup invalidates the dependent scope in the affected environment. Variable references are replaced by their value in each environment before fingerprinting, so a variable's value changes only the fingerprints of that environment, and its name and description never count. References inside expressions count by their type and value; compilation binds them as named DuckDB parameters, and lineage labels those values with the variable names. No edit executes SQL automatically.

## Execution service

`Engine.launch(worktree, environment, target, entry_point)` is the shared service. HTTP callers record `manual` origin and `ui`, `api` or explicitly approved `assistant` entry point. A lock reserves a worktree before preparation. Busy requests receive 409; no task is queued. Reservation spans preparation, execution, cancellation and cleanup, across all environments in that worktree. Other worktrees can run independently.

Accepted runs capture project code, parameters, graph, environment, the resolved variables of their scope and resolved connection settings. A coordinator thread owns a cursor proxy in the isolated SQL worker. Every requested ancestor runs once in topological order, including valid sources. Independent branches continue after a node failure; failed descendants are blocked. HTTP execution initializes only project-authorized connections that are fully configured for the environment before locking the worker configuration; nodes using an incomplete connection are blocked. The worker starts outside the engine lock, so status and stop requests do not wait for connection setup. Remote object storage prefixes follow each connection's secret type, not its identifier. Changes to connection configuration or grants require idle executions and discard affected workers and cached results. Trusted in-process service clients without an `Access` policy retain lazy connection preparation; the HTTP application always supplies the policy.

Outputs are staged under fresh physical names and published together only after all blocks succeed. A run first drops the results of nodes removed from its definitions. A failed or canceled node keeps its previous successful output set as stale. No downstream node uses that set as a fallback. Publication rechecks computation fingerprints, so an edit during a run cannot make outdated results appear valid.

A stop request sets a cancellation token and calls `interrupt()` on the active cursor. No later node starts. The worktree stays reserved until the operation and cleanup finish. External effects obey DuckDB and the extension: completed writes remain completed, and interrupted writes can have unknown or partial effects. Shutdown requests cancellation and waits for workers before closing their databases.

Run records are persisted at admission and at each node/status transition, including SQL, timings, sanitized connection snapshots, code definitions and observed write outcomes. On restart, unfinished records and their running or pending nodes become interrupted; no computation or export is replayed. In-memory result tables are not persisted.

### Scheduling decision

The MVP uses the embedded execution service without a scheduler or persistent task queue. A completed comparison with SqliteHuey selected APScheduler 3.x as the preferred future scheduling adapter. Queue persistence does not replace worktree admission, live result contexts or durable run history, and consuming queued work after a restart would require an explicit policy for replaying external writes. Neither scheduling library is a current dependency; the prototype and its report remain in Git history.

Future schedule and webhook handlers must submit worktree, environment, scope and trigger identity through the same execution service. They must capture fresh configuration, keep connections and credentials out of trigger payloads, and reject occupied worktrees without deferring the request. Before enabling automation, define time zones and DST, missed occurrences, rejected-trigger outcomes, webhook authentication and idempotency, and retention policies. Schedules, webhooks, retries and missed-run replay are not enabled in the MVP.

## Lineage concurrency

Public views contain exactly the query's original columns. Private tables hold stable row identities and, where safe, hidden input witnesses or grouping keys. Deterministic native-equivalence tests compare values, types and multiplicities against DuckDB without instrumentation. Uncovered SQL remains executable; exploration reports limitations explicitly.

A lineage request registers its result generation and dependency nodes. Recalculation marks affected generations stale, interrupts their lineage cursors, rejects new requests and waits for canceled readers to relinquish the old tables before retiring them. Unrelated requests remain active. The browser validates the selected generation and discards late responses; it never automatically follows an old row into a new result.

## HTTP surface

The stable `/api/v1` automation contract covers Job discovery, launch, asynchronous waiting, cancellation and text logs. Its separate OpenAPI schema is available at `/api/v1/openapi.json`; other routes remain internal to the interface. `duckpad run` is a standard-library client of this contract: the CLI dispatches it before importing the server, so it loads neither DuckDB nor the application. See [Automate Jobs](AUTOMATION.md) for authentication, idempotency, error codes, exit codes and examples.

Protected `/api` routes require a session cookie, a bearer session token, or an API token sent as `Authorization: Bearer dpk_…`. API tokens authenticate as their owning account with its current permissions; only their SHA-256 hashes and lifecycle metadata are stored. They are never accepted from cookies and cannot authorize SSH key management or network Git. Service accounts authenticate only with API tokens. Public login and OIDC callback routes remain unauthenticated. Mutation requests reject a mismatched browser Origin. The static login shell is public; project content is authenticated.

The administrator-only resource widget samples machine-wide counters every two
seconds and retains two minutes of history in the browser. CPU is the change in
busy time divided by the change in total time across all cores; Linux guest time
is counted once and I/O wait is excluded from busy time. RAM is physical memory
minus available memory, so reclaimable caches count as available. Measurements
cover all applications on the server OS (the guest OS for a VM), independent of
Duckpad's workers, CPU affinity or container quotas. In containers, the operating
system counters exposed by the runtime determine visibility. Missing metrics are
shown as unavailable, and CPU sampling resumes after two valid snapshots.

The main endpoint groups are `/session`, `/workspace`, `/projects`, `/example`, `/worktrees`, `/catalog`, `/environments`, `/runs`, `/conflicts`, `/library`, `/users`, `/api-tokens`, `/password`, `/ssh-key`, `/git-hosts` and `/resources`. `/assistant` exposes settings, provider discovery/testing, allowed models and private conversations; `/assistant/conversations/{id}/messages` streams NDJSON, `/approvals` resumes a deferred run proposal after an owner decision, and `/stop` cancels the request. Uploads use `/worktrees/{id}/uploads` and are stored under `resources/<project>/`. `/projects/import` creates a project from the declarative files of an uploaded ZIP and reports referenced connections and absolute input files that the archive cannot carry. Request bodies are validated; invalid requests receive a 422 response in the same `{"error", "detail"}` format as other failures. A worktree exposes definition snapshots and saves, variable summaries, renames and launch scopes, branch/merge history, compiled SQL, status, previews, lineage and manual run launch. See the route definitions in `src/duckpad/app.py` for request shapes. APIs use the same services as the interface; there is no second runner or separate editor state.

Execution and result operations require an explicit configured environment. Under
`/api/worktrees/{worktree}`, GET `status`, `compile/{node}`, `preview/{node}`,
`exports/{node}`, `exports/{node}/download`, and `generations/{identity}` require
the `environment` query parameter. POST `runs` and `lineage` require
`environment` in their JSON body. Omitting it returns 422 before the operation
runs; an unknown or deleted environment returns 404. No operation defaults to
`dev`. The interface selects from the current catalog and sends that selection.

For example, with a configured `prod` environment:

```http
POST /api/worktrees/{worktree}/runs
Content-Type: application/json

{"environment": "prod"}
```

Read its results with `GET /api/worktrees/{worktree}/preview/{node}?environment=prod`.
Downloads also require the export run ID:
`GET /api/worktrees/{worktree}/exports/{node}/download?environment=prod&run={run}`.
The initial `dev` and `prod` catalog entries are editable configuration, not API defaults.

## Authorization and execution isolation

The server rechecks the account, instance role and project membership on every
request. Invisible projects and their worktrees, runs and conflicts return 404.
Readers may inspect existing results and lineage, but cannot launch computation,
change files, create branches, import definitions, cancel runs or upload files.
Operators add permission to launch, cancel and rerun Jobs, while ad hoc execution
and editing require Editor access. Job administration requires Project Admin.
The `job` table stores stable instance-wide slugs, target references, tag commits,
environments, scopes and an append-only version audit. Jobs are outside project Git.
Internal Git refs retain promoted and executed commits against tag movement and
garbage collection; they are neither branches nor published remote refs.
Each Job owns a detached `read_only` worktree. The file watcher skips it; route
permissions reject all writes even by instance admins, and execution never commits
or prunes its documentation. Under the repository lock, a launch checks admission,
resolves a branch or uses the pinned tag commit, checks out that commit, then calls
the existing Runner. Separate Job worktrees can execute concurrently. A busy Job
returns 409 with its active run ID. Run snapshots retain the Job, tag, commit and
requester. Deletion retains the worktree record so cascading foreign keys cannot
erase run history or artifacts; project deletion still removes them.

Imports also require read access to their source project. Workspace, library and
execution lists filter private resources before returning them. Last-admin checks
and membership/account writes share a lock, including concurrent demotions.

Network Git acts as the requesting account. Fetch and push over SSH use that
account's key, only for an origin allowed by the instance's trusted Git hosts and
confirmed by that account for the project's current URL; HTTPS runs without
credentials. The server account's SSH keys, agent and Git credentials are never
used. See [Git synchronization](GIT.md#network-credentials).

SQL runs in a separate process per worktree/environment. The worker receives only
the project's authorized connection configuration and enabled extension requirements, and communicates through a
JSON-only protocol. It does not inherit the API's environment credentials or
SQLite descriptors. Before DuckDB creates threads, Linux Landlock restricts file
access to project resources/exports, explicit administrator-authorized local roots,
and read-only runtime libraries. Project Git metadata, other projects and instance
SQLite remain outside the data allowlist. Traversal and symlink escapes are denied
by the kernel. DuckDB external access is then disabled with explicit allowed paths;
auto-installation/loading of extensions and unredacted/persistent secrets are
disabled, and its configuration is locked before user SQL executes.

This default mode requires Landlock ABI 2+ on Linux x86-64 or arm64, including
inside containers. A missing or blocked sandbox causes an explicit execution
error; there is no automatic unrestricted fallback. Workers use the instance's
[SQL resources](INSTALLATION.md#sql-resources), which default to DuckDB's automatic
thread count and memory limit.
Project and connection extensions remain trusted administrator-installed code. Project
requirements load before configuration is locked, using local binaries from the declared
origin. They never install on demand. A changed requirement recreates the session at
the next execution and participates in result fingerprints. Approved remote
connections carry the privileges of their configured service credentials; operators
must scope those credentials and any network egress policy accordingly. This does
not provide tenant resource quotas or a complete hostile-code hosting boundary.
See the [DuckDB security guidance](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)
and [Linux Landlock API](https://docs.kernel.org/userspace-api/landlock.html).

The explicit `--trusted-local` startup option selects in-process DuckDB execution
for a single trusted user, including on Windows. It retains HTTP authentication,
API authorization, connection grants and template validation, but skips the SQL
worker and its OS and DuckDB sandbox configuration. Connections are prepared
lazily in the native cursor for each run, as for trusted service clients. SQL and
extensions have the application's OS permissions; this mode provides no SQL
isolation between projects or from instance metadata. The CLI requires a loopback
bind and prints a startup notice. It is not suitable for shared deployments or
access through a proxy or tunnel. The option is not persisted or inferred from
the operating system.

The default local connection covers only each project's resources and exports.
Additional local roots must exist and exclude the instance directory, its ancestors
and other projects. Existing results are not recomputed during read requests. Sample
projects receive their own input directories and connection grants. Users may
upload source files from the node inspector. Read-only roots stay read-only at the
OS layer even if SQL uses a different declared connection.
