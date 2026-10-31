# Lineage coverage

Lineage explains the materialized execution, not today's external resource. A result identifies its execution, dataset generation, column and stable storage row. Sorting or filtering the preview does not change those identities or restrict the provenance search.

Clicking a cell opens a large modal with a dependency graph: source cells on the left, calculations on the right. The selected value appears compactly in the header. All inputs on the current page are traced automatically; shared source cells appear once, connected to each calculation that uses them.

Calculation cards show the expression, its captured operand values when they can be bound unambiguously, and the result. For example, `amount * 2` becomes `10 * 2 = 20`. Small sums and averages show their complete numeric equation. Larger aggregates show their formula, the full contribution count and an explicit range for the five displayed inputs; a page is never presented as the entire calculation. Distinct value groups open their original rows while preserving the selected count.

An unchanged column passed through a projection, filter or join does not add a calculation node. This is determined from the parsed expression, not from equal values: `amount * 1` remains a calculation. Row-selection context from the collapsed steps stays available in source and calculation details. Coverage limits are explicit; source values, constants and unsupported steps terminate traversal.

Pan and zoom to explore the graph. Automatic tracing has a request budget; an unexplored value offers **Trace earlier inputs** to continue. Escape closes the dialog and restores keyboard focus to the selected cell. Recalculation interrupts all graph requests and navigation.

![Five source amounts and the sum they contribute to, with pagination for all 27 values](images/lineage.png)

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
- Projections that expand into several columns, such as `COLUMNS(...)`, `struct.*` or `UNNEST` of a struct: the step runs its native query without captured row witnesses, and lineage reports this limitation for its cells.
- Indistinguishable duplicate occurrences in a composed CTE/derived projection when no original row witness was captured. Use separate pipeline nodes to capture each stage's witnesses.

The response sets `complete: false` and identifies the unsupported step. The UI shows a coverage warning instead of presenting a partial search as complete. An unsupported construct does not modify the computed query values.

## Recalculation and stale results

A configuration edit or a manual recomputation invalidates the affected old generation. Pending lineage is interrupted, late responses are discarded, and further navigation is disabled. Recalculation does not automatically replay an explanation on the same row number. Select a cell explicitly after a valid replacement appears.

Failed recomputation retains the previous preview as stale, with its original SQL and execution metadata. It has no lineage. External source-file changes alone leave an existing valid result and its explanation unchanged until the next manual run reloads that resource.
