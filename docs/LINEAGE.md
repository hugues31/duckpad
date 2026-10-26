# Lineage coverage

Lineage explains the materialized execution, not today's external resource. A result identifies its execution, dataset generation, column and stable storage row. Sorting or filtering the preview does not change those identities or restrict the provenance search.

The explorer separates contributing value cells from selection/evaluation context and shows the calculation expression and referenced tables. Every cell remains navigable, including identical values from different rows. Results are paged in groups of five with an exact total. Source cells terminate the traversal; nested components retain instance-qualified paths.

## Validated baseline

| Construct | Status | Behavior |
| --- | --- | --- |
| Selected columns, arithmetic and scalar projections | Supported | Captured witnesses distinguish equal output values from separate input rows |
| Filters | Supported | Returned values retain their source cells; condition columns appear as context |
| Inner, left, right and full joins | Supported | Contributing cells retain the identities of their joined inputs; unmatched rows do not invent source cells |
| Grouping; `SUM`, `AVG`, `COUNT`, `COUNT(*)` | Supported | All participating cells are searched, with null-exclusion rules and captured group keys |
| `MIN`, `MAX` | Supported | All tied extrema appear first; the full examined group remains accessible |
| `COUNT(DISTINCT expression)` | Supported | Counted value groups first, then every original cell in a chosen group; both levels are paginated |
| Aggregate `FILTER (WHERE ...)` | Supported | Predicate inputs are context and excluded rows are not counted as contributions |
| `SELECT DISTINCT` | Supported | All rows contributing to the surviving value remain traceable |
| `UNION`, `INTERSECT`, `EXCEPT` (distinct semantics) | Supported | Both operands are explainable stages; `EXCEPT` separates the compared right side as context |
| Window `SUM`, `AVG`, `MIN`, `MAX`, `COUNT` | Supported | Frame membership is replayed over materialized inputs; extrema retain ties and aggregate null rules |
| Window `COUNT(DISTINCT ...)` | Supported | Distinct groups preserve duplicate source identities |
| `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST`, `NTILE` | Supported | Ordering and partition inputs explain the ranking |
| `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE` | Supported | The selected neighboring/frame cell is traced |
| Aggregate followed by a window | Supported | Grouping becomes an explainable intermediate relation before window evaluation |
| Ordered outputs and nested component compositions | Supported | Each step links to the actual earlier output from the same execution |
| Nonrecursive CTEs and derived tables | Supported with the duplicate-occurrence limitation below | Deterministic intermediate steps are materialized on demand from retained data |

The native-equivalence suite separately checks values, types and multiplicities for projections, decimal calculations, joins, grouping, windows, CTEs and set operations. The example combines the required baseline across reusable pipeline steps. The coverage target beyond that baseline remains incremental.

## Explicit limitations

These constructs remain executable when they satisfy the template contract, but exact lineage is not claimed:

- `UNION ALL`, `INTERSECT ALL` and `EXCEPT ALL`: duplicate-occurrence assignment is not implemented.
- Recursive CTEs, `QUALIFY`, grouping sets, `ROLLUP` and `CUBE`.
- SEMI/ANTI join selection provenance. The built-in join form offers inner/left/right/full joins.
- Multiple independent windows in one output expression, unsupported specialized windows or `IGNORE NULLS` wrappers.
- Window arguments that combine columns from multiple joined relations without an intermediate projection.
- Expressions combining several extrema into one cell, and multi-expression distinct aggregates/windows.
- Volatile expressions such as random values, UUIDs or current timestamps: replay must not invent an explanation from a new evaluation.
- Indistinguishable duplicate occurrences in a composed CTE/derived projection when no original row witness was captured. Use separate pipeline nodes to capture each stage's witnesses.

The response sets `complete: false` and identifies the unsupported step. The UI shows a coverage warning instead of presenting a partial search as complete. An unsupported construct does not modify the computed query values.

## Recalculation and stale results

A configuration edit or a manual recomputation invalidates the affected old generation. Pending lineage is interrupted, late responses are discarded, and further navigation is disabled. Recalculation does not automatically replay an explanation on the same row number. Select a cell explicitly after a valid replacement appears.

Failed recomputation retains the previous preview as stale, with its original SQL and execution metadata. It has no lineage. External source-file changes alone leave an existing valid result and its explanation unchanged until the next manual run reloads that resource.

## Contribution workspace

Click a valid preview cell for the compact explanation, then choose **Explore
lineage**. The selected preview cell stays highlighted. The large workspace pins
its business name and component instance path, output port, column, value and
stable storage row ID. **Execution details** exposes the original execution,
dataset generation, project, worktree and environment. Stable row IDs in this
workspace are zero-based storage identities; the preview's row numbering is
one-based for readability.

The inspector describes the currently selected step. Choose an input role in the
graph, detailed path, or records selector to inspect its complete retained rows.
**Inspect** follows the highlighted column of one of those rows upstream. The
breadcrumb and **Back to target** return to earlier steps without discarding
pages. Switching between **Graph** and **Detailed path** shares the same selection,
role and page state. Closing the workspace returns focus to **Explore lineage**;
closing the compact panel returns focus to the original preview cell. The editor,
its graph viewport, and preview sorting, filters and scroll remain mounted.

Solid edges represent value inputs, dashed edges selection/evaluation context,
and dotted edges row existence. Labels carry the same distinction without relying
on color. Repeated aliases have separate roles, even when they use the same
materialized dataset. The records table highlights the followed column, shows
column types and stable IDs, and retains duplicate values from different rows.
The participation count distinguishes a row used repeatedly by a join from the
number of unique source rows. These counts are evidence, not inferred weights or
percentages. Never add values across roles to reconstruct an arbitrary expression.

The workspace supports component/projection grouping, path isolation, search and
explicit fit-to-view. Grouping retains coverage warnings. Graph positions are
allocated once as stages and roles arrive; requests do not refit the viewport.
Use Tab and Enter to select graph cards, or Alt+Left/Right to visit recorded steps.
Escape closes the workspace. Both dividers accept pointer dragging or arrow keys.
On narrow screens, tabs switch between graph/path, step details and records.
Themes and translations follow workspace preferences.

### Evidence examples

- For `SUM(amount)` grouped by `region`, the inspector reports the operation,
  retained input count, argument and actual group key values. Examined and retained
  row counts distinguish null-excluded, filtered and non-extreme inputs.
- For `a.amount + b.amount`, alias `a` and alias `b` are separate roles. A self-join
  with three unique rows used nine times reports both counts. An unmatched outer
  input has **No matching row**; it does not produce an invented null source cell.
- For `CASE WHEN enabled THEN amount * 2 ELSE adjustment END`, the condition is
  context, the chosen arithmetic exposes evaluated intermediates, and the inactive
  value role is **Branch not selected**. A null cell in a selected unmatched input
  remains **No matching row**, not an inactive branch.
- `MAX(amount)` retains every tied occurrence. Its condition/context role exposes
  examined inputs. `COUNT(DISTINCT category)` first pages distinct groups, then
  drills into all original rows of the selected group, including duplicates.
- Supported windows expose partition, ordering and frame SQL and the retained
  frame records. Ranking inputs are evaluation context, not additive values.
  `COUNT(*)` depends on row existence, without treating an arbitrary first column
  as a numeric argument.

SQL and complete source records use disclosure. Scalar evidence is limited to 32
evaluated operands/intermediates. Aggregate counts describe rows, whereas role
totals describe cells of a specific role and column; they need not be equal.
Existing SQL coverage limitations above still apply.

### Model and request boundaries

The version 1 typed model in `lineage_models.py` separates a `Stage`, its `Role`s
and directed `StageEdge`s from record pages:

- `POST /api/worktrees/{worktree}/lineage/stage` receives an original `root` cell,
  selected `cell`, environment and request ID. Each cell includes dataset,
  execution, row and column. It discovers every immediate role and exact counts
  independently of any record page. It returns no sampled contributor list.
- `POST .../lineage/records` adds a role, offset, limit and optional distinct group.
  The response contains complete retained rows and participation counts, or a
  page of distinct groups. Default size is 25; the hard maximum is 100.
- `POST .../lineage/cancel` interrupts only the named investigation request. It
  never stops a pipeline or invalidates its preview. Cancellation before request
  admission is remembered briefly, so reordered requests cannot restart it.

Each request has a 10-second SQL budget and a 128-role topology budget. Exceeding
the topology budget returns an explicit unsupported/budget boundary. Timeouts and
request failures expose Retry; cancellation keeps the visited investigation. The
client limits an investigation to 64 explicitly opened cells. There is no automatic
recursive per-row enumeration. SQL plans use a bounded 64-entry cache, validated
against retained generations on every read. The client caches at most 120 record
pages; its keys include worktree, environment, original execution/generation,
selected occurrence path, role, group, page size and offset.

**Step explained** means the immediate computation has a supported rule.
**Sources reached** means all relevant upstream records have reached retained
sources. A non-source role remains **Upstream not explored** until every distinct
occurrence in that role has been visited and explained to sources. Visiting one
row of a 27-row aggregate cannot complete the other 26. Unsupported steps, proven
absence, inactive branches and pending exploration are distinct states, including
inside collapsed groups. This intentionally exposes partial exploration instead
of drawing a complete graph from the first page.

Every response is checked against its active selection; aborted or late responses
cannot replace a different role or generation. Recalculation invalidates the
original target, clears client caches, disables navigation, and requires a new
explicit selection in a valid preview. Source SQL is never replayed. SQL-only
intermediates may be materialized from retained dependencies; external relations
inside an intermediate are refused rather than reopened.
