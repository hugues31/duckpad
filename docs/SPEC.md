# Product contracts

This reference collects the constraints shared across features. Current usage
and file formats live in the linked guides; implementation details live in
[Architecture](ARCHITECTURE.md). Design records under `design/` distinguish
accepted decisions from features that are still proposed.

## Projects, code and history

- Project definitions are readable files versioned in Git. The UI and external
  editors change the same files. A completed save commits even invalid content;
  errors remain editable and block the affected execution scope.
- Concurrent saves compare base, current and proposed content. Conflicting
  proposals survive reloads and restarts. Resolution rechecks current files;
  unrelated edits are preserved.
- Normal nodes own SQL; linked nodes share project-local templates. Components
  share definitions within a branch and keep instance parameters. Imports create
  independent copies, including nested definitions and documentation.
- Branches have isolated worktrees. Reviewed merges validate the resulting
  definitions and reject changes to the reviewed heads. A merge does not run or
  publish a pipeline automatically.

See [authoring](AUTHORING.md), [SQL](SQL.md), [components](COMPONENTS.md) and
[Git](GIT.md).

## SQL semantics and execution

- DuckDB and its extensions define SQL values, types, multiplicities and external
  effects. Lineage instrumentation must preserve those semantics. Every query reads
  only declared inputs, earlier outputs, resources and connections. Only a node
  without outputs writes externally, with explicit `COPY TO` or `INSERT`; Duckpad
  adds no hidden truncation, append or filename changes.
- A launch captures committed definitions, environment, parameters, variables and
  connection settings. Later edits do not change that run. Publication compares
  current fingerprints so outdated results remain stale.
- A worktree admits one run through preparation, execution, cancellation and
  cleanup, across all environments. Busy requests are refused without queuing.
  Requested ancestors run once per launch, including sources with valid results.
- Outputs publish together after queries, tests and messages pass. A failed node
  retains its previous successful set as stale, but descendants cannot use it as
  fallback input. Independent branches continue unless the run is canceled.
- Cancellation stops future work and interrupts active SQL. It does not reverse
  completed writes or promise that an interrupted external write had no effect.
- History persists; unfinished runs become interrupted on restart. Restart never
  resumes a run or repeats an export. Ordinary in-memory results require recomputation.

See [tests](TESTS.md), [messages](MESSAGES.md) and
[execution](ARCHITECTURE.md#execution-service).

## Validity and lineage

Results belong to a worktree and environment. SQL, parameters, input edges,
extension requirements and data-selecting connection settings affect validity.
Layout, labels, documentation and credential rotation do not. External source
changes alone leave a retained result valid for its recorded execution; refresh
requires a run.

Lineage follows stable dataset generations and row identities over retained
execution data. Samples never limit its search. Recalculation cancels affected
readers; stale data has no lineage. Unsupported SQL remains executable and must
report incomplete provenance explicitly. The [coverage matrix](LINEAGE.md)
is the reference for supported constructs and limitations.

Ordinary variables resolve per environment. Computed variables require a valid
single-row source and retain execution provenance without rewriting declarations.
Partitions freeze typed keys, execute per-key work and require complete valid
inputs for collection. See [variables](VARIABLES.md), [partitions](PARTITIONS.md)
and [results](RESULTS.md).

## Instance access and automation

Accounts and project roles govern every request. Instance connections, secrets,
Jobs, environment configuration and extension binaries remain outside project Git.
Historical project revisions use the current granted connections when run.
Default SQL isolation requires Linux Landlock; trusted local mode is an explicit
single-user option. See [installation](INSTALLATION.md), [connections](CONNECTORS.md)
and [security](../SECURITY.md).

Jobs run pinned tags or branch heads in read-only worktrees. Operators can launch
Jobs without editing projects; project administrators configure and promote them.
The versioned automation API provides idempotent launch, waiting, cancellation and
logs. External schedulers choose when to run; built-in schedules, webhooks and
caller-supplied variable overrides remain unimplemented. See [Jobs](JOBS.md),
[automation](AUTOMATION.md) and the [remaining proposals](design/JOB_AUTOMATION.md#delivery-plan).

## AI assistant

The assistant is disabled until an instance administrator configures it. Tools
recheck access, edits use normal versioned saves with Undo, and runs require
explicit approval bound to the proposed configuration. Conversations are private
to their author, including against other instance administrators.

The provider receives instructions, tool schemas, the question, validated page
context, conversation history and requested tool results:

| Content | Data reading disabled | Data reading enabled |
| --- | --- | --- |
| Flow nodes, edges, parameters, component interfaces, template links | Yes | Yes |
| Saved project definition files: SQL, README, descriptions, variables, extension requirements and manifest | Yes, including literal/variable values in these definitions | Yes |
| Compiled SQL and bound project parameters | Yes, resolved connection secrets redacted | Yes, resolved connection secrets redacted |
| Materialized output schemas, counts, generation IDs and statuses | Yes | Yes |
| Run IDs, environment, timestamps, statuses, durations, commits and per-node status | Yes | Yes |
| Run error text and node message text | Withheld; only error presence | Yes, bounded |
| Historical executed SQL and data-test results | SQL tool absent; result text withheld | Yes, bounded; connection secrets redacted |
| Run proposals, approval/refusal and launched run metadata | For project editors/admins; always explicitly approved | Same |
| Output preview values and filters | Tool absent | Bounded existing output rows |
| Value lineage: selected value, SQL/expression, contributing values, source/schema metadata and limitations | Tool absent | Bounded contribution pages |
| Search excerpts from saved project definitions | Yes | Yes |
| Current-branch Git commit metadata (including authors, messages and hashes) | Yes | Yes |
| Requested write arguments and resulting change summaries, SQL diffs and commit IDs | For project editors/admins | For project editors/admins |
| Provider keys, resolved connection secrets, instance users, sessions, other projects and unsaved editor drafts | Never | Never |


The data-reading switch governs result access, not secrets embedded in
user-authored text. Questions, code, variables and commit messages can contain
sensitive values even when data reading is disabled. Turning it off prevents
resuming conversations that previously allowed data, so old values are not resent.
Provider discovery uses the configured key; a connection test sends only a short
verification prompt. Provider redirects are disabled.

Tools cannot execute arbitrary SQL, access arbitrary files or change instance
settings. Each writing action produces a commit; Undo creates an inverse change
and preserves independent later edits. Stopping a response does not undo saved
actions. Run confirmations persist across reloads, cannot be replayed, and must be
renewed when the proposed configuration changes. Stop cancels the model request;
Cancel run cancels execution. Neither reverses completed external writes.

Each turn is bounded to 12 provider requests, 30 tool calls and 120 seconds.
See [the assistant guide](ASSISTANT.md) for configuration, editing and debugging.

## Validation

Keep native-equivalence checks for SQL and lineage, service tests for execution
and access, and browser scenarios for user workflows. Historical benchmark
reports describe their measured environment; they are not current CI results or
performance guarantees. See [validation](VALIDATION.md) and the
[contributor checks](../CONTRIBUTING.md#run-the-checks).
