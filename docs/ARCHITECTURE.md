# Architecture

FastAPI serves the React application and authenticated API. SQL runs in isolated
DuckDB workers by default. Git stores project definitions, SQLite stores instance
metadata, and execution contexts retain result data.

## Modules

Paths below are relative to `src/duckpad/`.

| Modules | Responsibility |
| --- | --- |
| `app.py`, `cli.py` | Application wiring, lifecycle, static interface, startup and instance process lease |
| `api/`, `schemas.py` | Session, account, admin, project, worktree, Git, Job and result routes; HTTP errors and request dependencies |
| `auth.py`, `access.py`, `project_view.py` | Accounts, project authorization, membership views and editor snapshots |
| `services.py` | Service wiring shared by the API, tests and scripts |
| `models.py`, `store.py`, `migrations/`, `paths.py` | Instance schema, transactions and directory layout |
| `catalog.py`, `sealing.py`, `secret_references.py` | Connections, environments, secret encryption and server references |
| `projects.py`, `bundle.py`, `archive.py`, `merge.py` | Project files, snapshots, save conflicts, ZIPs and semantic merges |
| `project_files.py`, `json_document.py`, `project_schema.py`, `validation.py`, `processing.py` | File registry, lossless JSON, document schemas, ordered semantic validation and node processing inputs |
| `git/` | Git commands, worktrees, remote synchronization and account credentials |
| `templates.py`, `builtin_templates.py`, `components.py`, `graph.py` | SQL compilation, node contracts and graph expansion |
| `variables.py`, `partitions.py`, `partition_runs.py`, `partition_storage.py` | Value resolution, partition planning, attempts and retained artifacts |
| `engine.py`, `execution/`, `datasets.py`, `materialize.py` | Admission, workers, cancellation, publication, previews and invalidation |
| `lineage.py`, `trace/`, `sqlast.py`, `partition_lineage.py` | SQL analysis and provenance over retained execution data |
| `sandbox.py`, `sql_worker.py` | JSON RPC, worker processes and filesystem restrictions |
| `extensions.py`, `project_extensions.py` | Instance imports and versioned project requirements |
| `jobs.py`, `automation.py` | Reviewed execution targets and the versioned automation API |
| `assistant/` | Provider configuration, private conversations, tools and run approvals |
| `resources.py`, `example.py` | Machine resource counters and the Northstar fixtures |

The frontend's `api.ts` owns HTTP access. `routes.tsx` selects components in
`pages/`; `App.tsx` provides the signed-in layout. `shell.ts` and `worktree.tsx`
share session and working-branch state. See [Contributing](../CONTRIBUTING.md)
for source layout and checks.

## Files and data

The instance directory holds `instance.sqlite`, projects, worktrees, uploads,
extensions and exports. Its default master key is `duckpad-master.key`; operators
can supply it separately. The directory uses mode 0700 and SQLite uses 0600.

Project repositories contain the [declarative files](AUTHORING.md#project-layout-and-python-dependencies).
They exclude source data, results, virtual environments and instance settings.
Running an old project commit still uses the current connection catalog.

SQLite stores accounts, access grants, configuration, Jobs, conversations, save
conflicts and execution history. `Store` encrypts connection secrets, provider
keys, the SSO client secret and SSH private keys on write; services decrypt them
on read. Passwords, sessions and API tokens are hashed. See
[persistence](../docs/PERSISTENCE.md) for transactions and migrations, and
[installation](INSTALLATION.md#secrets-and-the-master-key) for key management.

Ordinary result tables live in a worktree/environment DuckDB context and disappear
on backend shutdown. Partitions also retain immutable disk artifacts for
collection and bounded previews. History persists independently.
Export downloads use separate saved copies of the latest successful exported
bytes. See [results](RESULTS.md) and [partitions](PARTITIONS.md).

## Settings scopes

| Scope | Entry point | Contents |
| --- | --- | --- |
| Instance | Instance settings | Accounts, SSO, assistant, Git hosts, environments, connections, extension imports and SQL resources; instance admins configure them |
| Project | Project settings | Membership, connection grants and deletion; project admins manage membership, instance admins grant connections |
| Project definition | Workspace tabs | Flow, SQL, documentation, variables, views and extension requirements; versioned with the branch |
| User | Account menu → User settings | Password, API tokens, SSH key, language and theme |

Language and theme are browser-local, shared by accounts using that browser.
Project roles and permissions are listed in the
[access matrix](INSTALLATION.md#accounts-and-project-access).

## Browser navigation

| URL | Destination |
| --- | --- |
| `/projects` | Project dashboard |
| `/instance-settings/:section` | Instance configuration |
| `/user-settings` | Account settings |
| `/projects/:projectId/jobs` | Jobs |
| `/projects/:projectId/settings` | Project settings |
| `/worktrees/:worktreeId/:tab` | Flow, Code, Documentation, Variables or History |

Worktree IDs avoid putting branch names or paths in URLs. The optional
`?environment=dev` selects a configured environment. Unknown routes show a
not-found screen; inaccessible resources show an unavailable screen.

Sign-in preserves a validated internal destination, including across OIDC.
Code drafts survive tab changes within a worktree. The flow's editors (Inspector,
node documentation, docked code editor) save after a typing pause, on blur and on
close, and navigation waits for them. Leaving with drafts that need an explicit
save, or after a failed autosave, requires confirmation; reloads use
`beforeunload`. Responses from an old worktree cannot replace the current snapshot.

FastAPI's final route serves the application shell for direct navigation. API
routes, `/assets` and the optional `/site` documentation mount precede it.

## Save and capture

A UI save includes its base revision. The writer compares that revision, current
files and the proposal. Disjoint fields merge; conflicting edits retain all three
versions in SQLite for resolution. Invalid saves are still committed and diagnosed.
A save reports the commit it created. Canvas undo posts that commit to
`/revert`, which saves its inverse with the same three-way merge (base: the
commit, proposal: its parent), so later independent edits remain; reverting the
undo commit redoes the change. The page keeps these commits per session.
Computation conflicts block affected execution scopes; metadata-only conflicts do
not. Resolution rechecks current files before writing.

The watcher batches external edits after 500 ms of inactivity. UI saves suppress
duplicate watcher commits. Workspace launches first save pending editor drafts;
the backend finalizes external batches and captures committed files through
`git archive`. A failed save prevents launch.

Static comparisons and computation fingerprints share the node inputs defined in
`processing.py`: executable code, parameters, enabled extensions, partition plans,
and Python modules, dependency manifests and lockfiles for Python nodes. Fingerprints
also include input results, the Python runtime and non-secret connection settings.
Layout, labels and documentation do not count.
Variables count by their resolved type and value in the selected environment.
Credential rotation preserves validity; missing secret references block connection
use without marking its existing results stale. Edits never start a run.

The project file registry maps each supported path to its bundle section, merge
strategy and comparison entity. Structural errors identify the affected file before
graph expansion; validation preserves independent manifest and module diagnostics.
Malformed optional JSON stays editable without changing its original text. Computed
variable graph diagnostics belong to `value_sources.py`; validation runs expansion,
partition planning, variable checks and shared view checks in that order.

Save callers choose an explicit commit context (workspace, external, import or
conflict resolution). A supplied commit message overrides the semantic summary,
including dependency locking and documentation pruning. Compiled statements carry
one `sql` field through filtering, execution and the run log.

## Execution service

The engine reserves the worktree before preparation and keeps it reserved through
execution, cancellation and cleanup. A second launch, including in another
environment, receives 409; it is not queued. Other worktrees can run concurrently.
Jobs own separate read-only worktrees and use the same execution machinery.

Accepted runs capture the commit, graph, parameters, variables, environment and
connection settings. Requested ancestors run once in dependency order, including
sources with valid prior results. Computed variables and partition manifests have
a value phase before their consumers. Independent branches continue after failure;
descendants of a failed node are blocked.

Each node stages its outputs and publishes them together after all queries and
error checks pass. Failure or cancellation retains its previous successful set as
stale; descendants cannot consume it as a fallback. Publication rechecks current
fingerprints, so an edit during execution cannot make outdated results valid.

The compiler checks each query or write against the node's declared inputs,
resources and connections. A node without outputs can write externally; run
records mark it with `writes_external` to track the write outcome.

### Connection changes

Saving connection settings or granting a connection preserves results. At the
next run, the engine compares the worker's attached setup with current settings,
including resolved secrets. A changed setup requires a replacement worker.
Tables and views transfer through a temporary DuckDB file, preserving row IDs.
Readers interrupted by the transfer must reload.

If replacement setup fails, the launch is refused and the prior results remain.
Attached database files require releasing their locks first; results then wait
without connections until setup succeeds. A failure while loading transferred
tables can reset the context without results. Deleting a connection or revoking a
grant closes affected workers and requires idle projects. Extension imports and
environment changes can also clear contexts.

### Cancellation and recovery

Stop sets a cancellation token and interrupts the active cursor. No later node
starts; admission remains locked until cleanup finishes. Completed external writes
remain completed, and interrupted writes can have partial or unknown outcomes.

Run records persist at admission and node/status transitions with SQL, timings,
redacted configuration and write outcomes. Startup marks unfinished records
interrupted; it never resumes computations or repeats exports automatically.

### Scheduling decision

[Jobs and the automation API](AUTOMATION.md) support external schedulers. Duckpad
has no built-in calendar scheduler, webhook trigger or persistent execution queue.
Unimplemented automation proposals are tracked separately in the
[design record](../docs/design/JOB_AUTOMATION.md#delivery-plan).

## Lineage concurrency

Public views expose the original query columns. Private tables retain stable row
identities, input witnesses and grouping keys where supported. Native-equivalence
tests compare values, types and multiplicities with uninstrumented DuckDB.
Unsupported lineage never changes query results; the
[coverage matrix](LINEAGE.md) lists the limits.

Each lineage request registers its generation and dependencies. Recalculation
interrupts affected readers and waits for them before retiring tables. The browser
discards late responses and requires selecting a new result explicitly. Unrelated
lineage requests remain active.

## HTTP surface

The stable `/api/v1` contract covers Job discovery, launch, waiting, cancellation,
partitions and text logs. Its schema is `/api/v1/openapi.json`.
`duckpad run` uses this contract without importing the server or DuckDB.
Other `/api` routes are internal UI contracts; request shapes live in `schemas.py`
and the `api/` routers. Each router accepts a shared `Context` and declares its
resource permissions through dependencies in `api/security.py`. Authentication
and origin checks run before dispatch; blocking authentication and authorization
use the thread pool. `tests/test_access.py` inventories the access level of every
internal and automation route.

`api/http.py` owns cookies, error responses, upload admission and security headers.
The export download route explicitly permits same-origin framing, including its
JSON errors. Other responses deny framing. `api/deps.py` shares partition query
selection and requester identity with the automation API. Structural project
edits use `Projects.transform` to check and write one revision under the same lock.

Protected routes accept session authentication or a bearer API token. API tokens
use their owner's current permissions and cannot manage SSH keys or perform
network Git. Browser mutations reject a mismatched Origin. Login and OIDC
handshake routes are public.

Worktree execution and result operations require an explicit environment:

```http
POST /api/worktrees/{worktree}/runs
Content-Type: application/json

{"environment": "prod"}
```

Read results with
`GET /api/worktrees/{worktree}/preview/{node}?environment=prod`.
Export downloads also require `run={run}`. Missing environments return 422;
unknown ones return 404. The initial `dev` and `prod` entries are editable catalog
values, not API defaults.

## Authorization and execution isolation

The API checks the account and project role on every request. Invisible projects,
worktrees and runs return 404. Imports also require access to the source project.
Job result worktrees reject edits even by administrators.

An isolated SQL worker receives only authorized connections and enabled
extension requirements over JSON RPC. It inherits neither the API's environment
credentials nor SQLite descriptors. Before DuckDB starts threads, Linux Landlock
limits files to project resources/exports, granted storage roots, granted
database directories and read-only runtime libraries. Roots and database
directories are writable only when their connector declares `write`; read-only
roots stay read-only at the OS layer even if SQL names another connection.
Database journals require directory access, so each database and environment
should have a dedicated directory. Instance metadata, project Git metadata and
other projects stay outside the allowlist.

DuckDB then locks its configuration: external access is limited to allowed
paths, automatic extension loading/installing is disabled, and secrets are
temporary. Missing Landlock ABI 2+ causes an execution error with no
unrestricted fallback. Extensions remain trusted administrator-installed native
code. Remote connections act with their configured credentials; scope those
credentials and network egress accordingly. This is not a tenant resource quota
or a complete hostile-code hosting boundary.

The explicit [trusted local mode](INSTALLATION.md#trusted-local-mode) runs DuckDB
in a worker with the user's OS permissions. It retains HTTP authorization but has
no SQL filesystem isolation and must remain a single-user loopback installation.

Enabled [Python nodes](PYTHON.md) share that worker and its DuckDB connection,
using a locked project interpreter and a lightweight injected SDK. Only control
messages, schemas and preview pages cross the process pipes; tabular relations
stay in the worker. Native failures discard that context, and the next run
recomputes it. Linux workers prefer OOM termination via `oom_score_adj=1000`;
Python allocations have no separate quota. Network and same-user signals are
unconfined. Python is an opaque lineage boundary retaining captured parents.

Network Git uses the requesting account's key, trusted host configuration and
URL-bound consent. It never borrows the server account's credentials; see
[network credentials](GIT.md#network-credentials).

## Assistant boundary

Assistant tools recheck session, project access and configuration revision;
result tools also check connection grants. Writes use the project writer and
inverse merges for Undo. Runs require persisted approval bound to the proposed
configuration. There is no arbitrary SQL or network tool.

Conversations belong to their author, without an administrator read override.
They store Pydantic AI message history in SQLite; simultaneous turns return 409.
Provider errors omit SDK response bodies. Tests disable real model requests.
See the [assistant guide](ASSISTANT.md) and its
[provider data contract](../docs/SPEC.md#ai-assistant).
