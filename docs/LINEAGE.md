# Lineage coverage

Lineage explains the materialized execution, not today's external resource. A result identifies its execution, dataset generation, column and stable storage row. Sorting or filtering the preview does not change those identities or restrict the provenance search.

The explorer keeps the selected value visible above a timeline running backward to its inputs. Steps with a single contributing cell are followed automatically; at a branch, choose an input to continue to its source. Select any earlier step to explore a different input. The timeline shows one explored path, not every branch of an aggregate or join.

Each step describes its operation in plain language, with the expression available under **View calculation**. **Why these rows?** separates selection/evaluation context from contributing cells. Distinct value groups open their original rows without adding a fictitious calculation step. Every cell remains navigable, including identical values from different rows. Results are paged in groups of five with an exact total. Source cells terminate the traversal; nested components retain instance-qualified paths.

**Play this path** highlights the explored steps in creation order, from the earliest input toward the selected value. Pause or select a step to inspect it, then resume; replay after reaching the result. Playback never executes the pipeline or implies that one chosen contribution is the entire calculation. Reduced-motion preferences disable movement while preserving the step highlights.

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
