# Frontend and backend code review

Reviewed revision: `a2e834fcbb25fa8ba54676b7818eb31a385ae693`.
This report covers the current application, rather than the earlier task baseline.
Source locations below refer to that revision. This change contains review findings;
it does not implement the proposed fixes.

## Assessment

The application already has useful boundaries: API routers, application service
wiring, execution services behind `Engine`, dedicated Git and trace packages,
central frontend resource/polling hooks, and revision-aware drafts. A broad rewrite
would discard tested behavior without addressing the most concrete problems.

The immediate public findings are two reproduced input-handling defects, a
quadratic graph traversal, and a large initial browser bundle. The remaining
recommendations concern cohesive extractions from modules that combine several
responsibilities. File length alone is not treated as a defect.

## Scope and method

The tracked Python application contains 164 files and 35,491 lines, including
migrations and example fixtures. The frontend contains 267 production TypeScript
files (50,789 lines), 32 stylesheets (10,704 lines), and 78 colocated test files
(11,642 lines). Generated assets, dependencies and end-to-end tests are excluded
from these frontend totals.

The review combined a repository-wide source inventory and reference search with
focused source tracing, disposable reproductions, static checks, unit tests and
selected browser tests. It is not a proof that every branch is correct.

| Area                                | Review focus and conclusion                                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API, authentication and access      | Router boundaries, request schemas, project roles, session handling; catalogue mutation still accepts structurally unchecked nested data.                                                     |
| Persistence and Git                 | Store transactions, revision conflicts, rollback and watcher lifecycle; preserve those invariants while reducing `Projects` responsibilities.                                                 |
| SQL execution, workers and Python   | Launch preparation, connection capture, cancellation and worker/runtime boundaries; the existing execution package is a useful boundary.                                                      |
| Variables, templates and components | Type interpretation, list input and graph traversal; reproduced list conversion and traversal findings below.                                                                                 |
| Partitions, results and lineage     | Dependency planning, result identity, column impact and contribution paging; analysis and presentation remain the main complexity hotspots.                                                   |
| Assistant and jobs                  | Tool access checks, conversation cancellation, launch orchestration and bounded outputs; no additional confirmed public defect from this inspection. Live model providers were not contacted. |
| Frontend shell, editors and forms   | Route loading, drafts, shared input controls, graph interaction and Monaco providers; preserve the existing polling and revision abstractions.                                                |
| Tests and delivery                  | Local checks, build output, shared parser cases and browser coverage; results and limitations are recorded below.                                                                             |

## Prioritized findings

P2 means a concrete correctness/performance problem or a focused change with clear
benefit. P3 means a maintenance improvement to perform when that area is next
changed. Effort estimates are relative: small is a bounded fix, medium changes
several collaborating functions, and large needs staged extraction.

### R1 — Typed list parameters lose their element types (P2, small)

Locations: `frontend/src/ParameterField.tsx:183`,
`frontend/src/ParameterInput.tsx:40`, `frontend/src/VariableFields.tsx:73`,
`src/duckpad/templates.py:551`.

`ParameterField` passes only the base type `list` to `ParameterInput`. Its parser
splits on commas and returns strings. A mounted `ParameterField` probe confirmed
that editing `list<number>` to `1, 2` emits `["1", "2"]`, and editing
`list<boolean>` to `true, false` emits `["true", "false"]`. Clearing either input
emits `[""]`. The server rejects the first two values as incompatible with the
declared element type. An initially valid typed default can therefore become
invalid when edited in the inspector.

`VariableValueInput` already adds its own numeric list conversion and blank-item
filtering around the same control. This is behavioral duplication with observable
drift, rather than merely similar JSX.

Pass the complete declared type into a shared value parser. Keep draft text while
editing and explicitly define empty-list, empty-string item, comma escaping and
invalid-item behavior. Do not silently discard invalid values. Keep node parameter
and variable type capabilities distinct: variables currently support fewer list
types than SQL parameters.

Acceptance: exercise actual fields for numeric, boolean, text and column lists;
verify the saved JSON and server compilation, empty values, invalid items, defaults
and blur behavior. Include a shared numeric-list case for both variable and node
forms.

### R2 — Malformed catalogue structures cause unhandled errors (P2, small)

Locations: `src/duckpad/api/admin.py:89`, `src/duckpad/catalog.py:183` and `:245`.

The mutation endpoint accepts `dict[str, Any]`. Semantic validation assumes nested
objects and arrays already have the correct shape. On a fresh instance, each of
these authenticated administrator requests returned HTTP 500:

```json
{"id":"badparam","family":"database","parameters":[null]}
{"id":"badcap","family":"database","capabilities":null}
```

These are bodies for `PUT /api/catalog/connector?create=true`. A connection body
with `"environments":{"dev":null}` also returns 500. The three reproductions did
not persist the rejected entity. This is an error-handling defect, not a claim of
unauthenticated access or demonstrated data corruption.

Introduce explicit connector/connection request schemas, including nested
parameter, extension and environment values, before semantic validation. Continue
to return domain errors for references, duplicate identifiers and capabilities;
do not mask programming errors with a broad exception handler.

Acceptance: malformed nested values return a useful 422 response and leave both
catalogue and execution state unchanged; valid custom and built-in overrides,
masked-value round trips and draft connection tests still work.

### R3 — Reachability repeatedly scans every edge (P2, medium)

Location: `src/duckpad/graph.py:34`. Callers include launch scoping,
fingerprinting/reuse, partition planning, schema impact and table lineage.

`reachable` builds the next set from the previous set, scanning all edges once per
distance from the seeds. A chain of N nodes takes N scans of N−1 edges. Disposable
forward-chain measurements on the review machine were:

| Nodes | Edge visits | Elapsed seconds |
| ----: | ----------: | --------------: |
| 1,000 |     999,000 |           0.095 |
| 2,000 |   3,998,000 |           0.380 |
| 4,000 |  15,996,000 |           1.680 |

These are single local samples, not a latency guarantee. The algorithmic cost is
independent of those timings. `column_impact.py:193` has a related fixed-point
scan for column dependencies; do not conflate its different edge semantics with
node reachability.

Use adjacency maps and a queue/stack with a visited set. Start with `reachable`,
whose set-valued contract is narrow, then consider reusing an index within one
immutable expanded graph. Avoid a process-wide cache without revision identity.

Acceptance: upstream/downstream results match for branches, multiple seeds,
duplicates, cycles and absent seeds; a chain requires linear edge visits. Preserve
the stable wave ordering of the separate `topological` function.

### R4 — Eager route imports enlarge the initial application bundle (P2, medium)

Location: `frontend/src/routes.tsx:12` and its page import graph.

The production build emits an initial JavaScript chunk of 1,898.12 kB
(599.77 kB gzip). All page components are imported eagerly, so loading the shell
also loads code for settings, history, documentation, jobs and the flow editor.
Monaco and Vega already have separate chunks; they should not be presented as an
unimplemented optimization. Their emitted chunks are also large, but serve
specialist features.

Separate lightweight route metadata used by navigation and `signInReturn` from
page implementations, then introduce route-level lazy loading. Consider optional
modal content only after measuring the resulting import graph. Do not change
editor mounting semantics merely to reduce the reported chunk size.

Acceptance: record initial transferred JavaScript before/after; test direct links,
login return paths, loading/error states and retained worktree drafts. No browser
CPU profile or representative production network measurement was performed, so
this is an opportunity with a measured bundle cost, not a measured startup delay.

### R5 — Column impact analysis mixes planning and edit construction (P3, large)

Locations: `src/duckpad/column_impact.py:175` (318-line `inspect`), `:495` and
`:632`; related hotspots are `column_analysis.py:19` and `lineage.py:99`.

`inspect` resolves the current graph/schema, propagates dependencies, compiles
nodes, maps SQL spans to authored parameters, classifies manual edits, constructs
candidate changes and prepares the review result. This makes changes to one SQL
case difficult to reason about independently from edit safety.

Extract an immutable analysis context, a pure per-statement edit planner and
report assembly. Keep verification and application separate, with the current
revision/token checks as the final authority. Later split column-expression
analysis by SQL construct, rather than moving a large function unchanged into
another file. Preserve the existing `trace` package instead of creating a second
lineage framework.

Acceptance: the current column-impact/lineage suites retain parity for aliases,
shared templates, nested components, unsupported SQL and stale review tokens;
add focused planner cases only where existing behavior is not characterized.

### R6 — Editor language providers share one large module (P3, medium)

Location: `frontend/src/codeIntelligence.ts` (1,622 lines; registration at `:1556`).

The module combines language/theme configuration, SQL catalogue data access,
completion, hover/signature documentation, markers, code actions and Python
completion. Its shared state and registration lifecycle make a language-specific
change harder to isolate.

Keep a small registration facade and a shared model-context/catalogue service;
extract SQL completion/documentation, diagnostics/actions and Python providers.
Preserve one registration/disposal path and explicit per-model context. The
existing `sqlTemplate.ts` parser is already separate and should stay independent
of Monaco.

Acceptance: retain completion, Unicode/directive, hover and marker tests; verify
two open models do not share the wrong context and registrations are not doubled
after reopening the editor.

### R7 — Flow and lineage views still combine state and presentation (P3, medium)

Locations: `frontend/src/LineageSteps.tsx` (990 lines, contribution paging at
`:794`), `Canvas.tsx` (860), `pages/FlowPage.tsx` (796), and `ModalHost.tsx` (712).

`LineageSteps` combines table traversal, recursive explanation presentation and
async contribution pagination. `CanvasInner` coordinates gesture/selection state,
search, layout and rendering. `ModalHost` contains unrelated project, connector,
branch and revision dialogs. These are concrete responsibility boundaries, not a
request to split every component above an arbitrary line limit.

Start with a contribution-paging hook and presentational contribution/step cards,
then move complete dialogs into their feature modules. Extract canvas command and
selection behavior only with existing interaction tests as a guard. Keep
`FlowPage` as the integration owner of worktree, selection and execution actions.

Acceptance: pagination errors and late responses, nested lineage, component
navigation, keyboard actions, canvas drags and unsaved dialog drafts keep their
current behavior. Reuse `useResource`, `usePolling` and `useRevisionDraft` where
their contracts fit; avoid parallel versions of those abstractions.

### R8 — Project lifecycle, observation and saved-file transactions are coupled (P3, large)

Locations: `src/duckpad/projects.py` (1,001 lines), especially `:361`, `:573`,
`:790` and `:880`.

`Projects` owns worktree lifecycle, snapshot caching, dependency locking,
revision-aware writes/conflicts, save rollback, documentation pruning and external
file observation. The Git package already extracts much of remote/workspace
behavior; recreating that boundary would add indirection without benefit.

First extract the file observer behind explicit start/stop/change callbacks.
Then isolate saved-definition transactions and rollback as one unit. Keep
repository locking and ordering visible in the coordinating service; spreading
lock acquisition across new helpers would make failures harder to diagnose.

Acceptance: preserve concurrent saves, stale revisions, failed Git commits,
disk/write failures, watcher edits, project deletion and shutdown tests. Verify
files, Git HEAD/index and stored metadata remain coherent after every injected
failure before undertaking the next extraction.

## Dead code, duplication and separation of responsibilities

- Ruff and TypeScript's unused-local/import checks pass. A source reference scan
  found no top-level Python definition or named TypeScript export occurring only
  at its declaration in the production source set. No deletion is justified by
  this audit. This heuristic does not prove all methods, CSS selectors, assets or
  dynamically registered entry points are reachable.
- A normalized ten-line exact-block scan found no substantive cross-file
  production duplication beyond execution-service constructor wiring. It does
  not detect similar algorithms or shorter fragments; R1 is the more useful
  example of duplicated behavior.
- The TypeScript and Python template parsers intentionally overlap. They already
  share `frontend/src/sqlTemplateLint.json` cases through
  `tests/test_templates.py:379`. Expand that contract when adding syntax rather
  than replacing client parsing with a network request on every keystroke.
- Result views already remount on environment identity
  (`ResultsPanel.tsx:412` and `:617`); the resource hook's narrower key alone is
  not evidence of cross-environment stale data. Revision-aware drafts and
  abortable resource requests likewise should be preserved.
- Dynamic `Record`/`Any` boundaries and scoped type-checker exceptions remain.
  The exception-budget check already prevents growth. Add explicit contracts at
  demonstrated weak boundaries such as catalogue requests and extracted analysis
  results; a blanket conversion of all runtime records would be a separate,
  expensive change with no demonstrated benefit here.
- Large stylesheets, migrations, fixture data and exhaustive SQL cases are not
  interchangeable with large orchestration functions. They were inventoried but
  do not warrant automatic splitting or removal.

## Verification

| Check                                                      | Result                                                                                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository setup and production frontend build             | Passed; bundle sizes recorded in R4.                                                                                                                                                         |
| Ruff lint and formatting                                   | Passed.                                                                                                                                                                                      |
| `ty check` and typing-exception policy                     | Passed.                                                                                                                                                                                      |
| TypeScript, translation consistency, ESLint and CSS checks | Passed; 1,819 translation keys consistent across four locales.                                                                                                                               |
| Frontend formatting                                        | Passed.                                                                                                                                                                                      |
| Frontend unit suite                                        | 80 test files, 558 tests passed.                                                                                                                                                             |
| Browser tests                                              | All six cases in `environments.spec.ts` and `project-navigation.spec.ts` passed.                                                                                                             |
| Python suite, Python 3.12                                  | 2,199 distinct cases passed across the full run and targeted rerun; two Delta cases skipped because the published extension cannot run on the test CPU.                                      |
| Focused review probes                                      | Both mounted list-input cases reproduced R1; disposable authenticated API calls reproduced R2; chain measurements reproduced R3. These probes assert observed defects, not successful fixes. |

The full Python command was `pytest -q -n 4 --dist worksteal`. Its first run
reported 2,184 passes, 15 failures and two skips: all failures were release tests
unable to find `git-cliff`. The pinned executable was installed in the virtual
environment, but that directory was absent from the launching shell's `PATH`.
After correcting the test command's environment, `pytest -q --lf
tests/test_release.py` passed all 15 affected cases (nine already-passing cases
were deselected). No repository or dependency change was needed. The complete
suite was not run a second time, and Python 3.11/3.13 were not exercised locally.

## Suggested implementation order

1. Fix R1 and R2 independently, with their reproductions promoted to regression
   tests. Each changes a narrow user-visible behavior.
2. Replace `reachable` for R3 and measure R4's initial-load improvement separately.
3. Extract one responsibility at a time for R5–R8 when the corresponding feature
   is next changed. Keep behavior changes out of those extraction commits.

No follow-up implementation issues were created by this review. External database
and live model-provider acceptance tests were not run; the selected browser tests
are not the full end-to-end suite. Security disclosure follows `SECURITY.md`.
