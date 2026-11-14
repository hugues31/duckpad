# Lineage coverage

Value lineage explains the materialized execution, not today's external resource. A result identifies its execution, dataset generation, column and stable storage row. Sorting, filtering or sampling the displayed rows does not change those identities or restrict the provenance search. Table and column lineage analyze saved definitions in the selected environment.

The **Lineage** side panel replaces the inspector while it is open. The canvas and Data grid remain usable; clicking another cell updates the explanation. Selecting another node on the canvas shows the lineage of that node, in the direction already shown; the browser Back button returns to the previous one. Escape closes the panel wherever the focus is, and keeps the selected node. Its table › column › value breadcrumb returns to either higher level. Until a value is explained, its column level lists the columns of the output: choose one there, or switch to another one, in the direction already shown. Its last level names the explained value, and brings it back in Data after other rows or nodes were opened. The canvas brings the traced path into view when a part of it is hidden. Origin and Impact are available at all three levels.

**Table Origin** lists source files or tables and connections, followed by the upstream path: the first input of a node continues it, and each other input forks beside it like a branch of a Git graph, with its own line. Two levels of forks are open; a deeper fork, or a branch of more than six nodes, waits folded behind a button naming how many nodes it holds and the sources it ends on. **Impact** lists downstream nodes and exports, including dependencies through computed variables. This analysis reads saved definitions and works before any run. Open it from a node's inspector actions or canvas context menu.

**Column Origin** opens from the table's column list, a **Lineage** button in **Columns**, or the column breadcrumb above a value. An export has no output of its own: like its results, its columns are those of its input, which it carries unchanged, and their Impact states that nothing reads them downstream. It separates value inputs from conditions that select rows: filters, joins, grouping, windows, ordering, DISTINCT and set membership. Every calculation and transport node remains visible, including nested components and side branches. Source steps include the column type, resource and description. Canvas badges show column names, with **ƒ** for calculations.

The analysis uses compiled saved SQL, with the selected environment's parameters and variables. It reuses the schemas of valid results; without a result, or once the definitions changed, it describes the saved code against empty typed relations in a database with external access disabled. Expressions are shown as written: a column is qualified by its input only when two inputs share its name. Column names keep their written case. A join whose inputs share column names needs one run, since the stored names of the duplicates exist only then. It never reads source files or output rows, runs a node, or changes results. If a schema cannot be determined, the panel names the node to run. Analysis is cached by definitions, environment, computed variable metadata and schemas; configuration edits invalidate it.

Static coverage includes qualified joins, aliases, SELECT stars with EXCLUDE/REPLACE, CTEs, derived tables, scalar subqueries and positional UNION, INTERSECT and EXCEPT. Correlated or recursive queries, named windows, pivots, expanding UNNEST projections, table aliases with column lists (`FROM t AS x(a, b)`) and set operations BY NAME are explicitly incomplete. Python is opaque and lists its input tables. These static limits are separate from the value replay limits below. The assistant's `explain_column` tool returns bounded pages of the same analysis, including when data reading is disabled.

**Column Impact** lists references to edit, outputs that carry the name, derived columns and exports. It includes SQL outputs, tests, messages, expression parameters, saved views, chart fields, computed variable sources and partition keys. Unaffected downstream nodes and documentation mentions appear separately. The canvas highlights affected nodes with edit, follows, calculation and file badges. The assistant's `column_impact` tool returns the same groups without reading data, including when assistant data access is disabled.

**Rename…** and **Simulate a type change…** open one at a time, under the summary of Column Impact. **Rename…** previews every changed file before applying one save, which the existing **Undo** reverses. SQL edits replace identifier tokens and preserve comments, directives and formatting. The defining alias and downstream references change together, including the uses of that alias in its own query (WHERE, GROUP BY, HAVING, ORDER BY and later projections); an output read from an input, a CTE or a subquery without an alias receives one. Renaming a source column updates project references and warns that the source must supply the new name. Documentation keys follow the rename. Shared definitions remain shared when their instances need identical edits; otherwise the affected instances receive separate definitions, keeping unrelated branches unchanged.

**Simulate a type change…** in Column Impact compiles downstream outputs, tests,
messages and export queries against empty typed inputs. It lists DuckDB errors
with links to the code, before/after output types and affected exports. Nothing
is saved, no run starts, and no result rows or external sources are read. Source
schemas must already be known unless the source is a literal SQL query. Python,
unsupported statements and outputs blocked by an unknown or failed upstream
schema are listed separately. Compilation does not prove that existing values
can be converted to the chosen type, or validate an export destination.

In **Compare & merge**, **Schema impact** checks the proposed merged definitions
in the selected environment, including conflict choices, without running either
branch. It reports added, removed, renamed and retyped columns, downstream
compilation failures (including consumers unchanged by the branch), and exports
whose input columns or row selection are affected. A rename is reported only
when an unchanged expression uniquely identifies the old and new column;
otherwise it remains an addition and removal. Unknown schemas are not treated
as empty outputs. Existing failures are distinguished from new ones. Changed
external source definitions need fresh schema metadata; their old schemas are
not assumed to describe the proposed source. Resolve conflicts before checking.

Invalid names and collisions in affected outputs are rejected before writing. Every rename is then verified without reading data: the edited definitions are analyzed again, and the rename is refused, naming the node, unless each downstream output keeps its columns, computed and selected from the same inputs. This covers a new name that another joined input already has, and outputs named by a set operation. A changed revision or schema requires another preview. Python, unsupported SQL, JOIN USING/NATURAL, affected star modifiers and expressions bound through variables are listed for manual review and are not automatically rewritten. A partition filter does not prevent static analysis, but unresolved partition expressions remain incomplete. Renaming invalidates affected retained results just like editing SQL; run the flow again before explaining their values.

**Value Origin** keeps every node on the path, including unchanged projections, filters and joins. The path appears step by step as it is traced, starting with the selected value. A value read from a source has nothing upstream: the panel offers to follow its row downstream instead. Each calculation shows its formula, captured operands and result. A transport step also shows the condition selecting its row. Components and nested components have named headers; **Open on the canvas** opens their contents while retaining the trace. A trace started inside a component continues through its external inputs.

Aggregates initially show five contributing values and the full result. **Show the N values** loads further pages, and **Open the N rows in Data** opens the contributing rows in the upstream node's grid, with search and pagination. These rows are recomputed from captured witnesses, never stored or read again from an external source. Distinct groups first open the corresponding original cells.

Only one contributing value is followed after an aggregate, initially the first. Selecting another value replaces that path. Mixed expressions such as `net_revenue / SUM(net_revenue) OVER ()` show the scalar operand and the complete window total separately, each with its own contributions. Other branches with at most three nodes open automatically; longer branches load on demand. Shared ancestors appear once with links back to them.

The canvas highlights the path, dims unrelated nodes and shows captured values. Numbers are rounded for display; hover shows the exact value. **Copy** exports the explanation as text with exact values, run, commit and environment. The URL preserves the node, output, generation and selected cell, so it can be shared and navigated with browser Back. Reopening an invalidated generation asks for a new selection rather than explaining a different result row.

![Northstar value lineage through nested components and a channel-fee branch](images/lineage.png)

An output whose query reads an external resource, or no flow data at all, is a lineage source: explanations stop at its rows and never reread the resource. To trace a calculation through external rows joined with an input, load them into an earlier output first.

## Validated baseline

### Downstream row impact

Select a source or intermediate cell and choose **Impact** to find where its row
stops or which outputs it reaches. The verdict names the stopping node and its
evaluated condition. Each consumer path shows kept, discarded, grouped, duplicated,
written, not reached or cannot follow steps. Component internals stay visible.
The canvas marks traversed nodes green, rejection nodes with a red cross, and
unreached nodes dimly.

Forward tracing searches captured row witnesses for projections, filters, joins
and row-preserving windows. It evaluates filter and HAVING conditions over the
captured input rows, reports missing keys for simple inner joins, and follows
captured group keys into aggregate rows. Global aggregates include all rows
selected by their input clauses. DISTINCT uses exact value tuples with NULL-safe
matching; DISTINCT ON cannot be followed, since equal values do not tell which row
it kept. A duplicated row lists five outputs per page; selecting a different
output changes the single row followed downstream. Only successful plain full-row
COPY/INSERT exports from the captured input generation are reported as written.

Python, composed CTE/subquery mappings, set operations, grouped windows, partitions
and other unsupported forward mappings show **Cannot follow**. After an unknown
mapping, downstream membership remains unknown rather than being called absent.
LIMIT/OFFSET rejection is not guessed. These forward coverage limits are separate
from Origin coverage below. No source is reopened, no export is replayed and no
result is changed. The assistant's `trace_row` tool returns the same verdict and
steps, subject to its data-reading permission and row budget.

### Upstream value origin

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
| Mixed scalar expressions and independent aggregate/window operands | Supported | Every operand has its own complete value and contribution page |
| Window `COUNT(DISTINCT ...)` | Supported | Distinct groups preserve duplicate source identities |
| `ROW_NUMBER`, `RANK`, `DENSE_RANK`, `PERCENT_RANK`, `CUME_DIST`, `NTILE` | Supported | Ordering and partition inputs explain the ranking |
| `LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE` | Supported | The selected neighboring/frame cell is traced |
| Aggregate followed by a window | Supported | Grouping becomes an explainable intermediate relation before window evaluation |
| Ordered outputs and nested component compositions | Supported | Each step links to the actual earlier output from the same execution |
| Nonrecursive CTEs and derived tables | Supported with the duplicate-occurrence limitation below | Deterministic intermediate steps are materialized on demand from retained data |

Native-equivalence tests compare values, types and multiplicities with
uninstrumented DuckDB. The matrix describes verified coverage, not all SQL.

## Explicit limitations

These constructs remain executable when they satisfy the template contract, but exact lineage is not claimed:

- `UNION ALL`, `INTERSECT ALL` and `EXCEPT ALL`: duplicate-occurrence assignment is not implemented.
- Recursive CTEs, `QUALIFY`, grouping sets, `ROLLUP` and `CUBE`.
- SEMI/ANTI join selection provenance. The built-in join form offers inner/left/right/full joins.
- Unsupported specialized windows or `IGNORE NULLS` wrappers.
- Window arguments that combine columns from multiple joined relations without an intermediate projection.
- Multi-expression distinct aggregates/windows.
- Volatile expressions such as random values, UUIDs or current timestamps: replay must not invent an explanation from a new evaluation.
- Projections that expand into several columns, such as `COLUMNS(...)`, `struct.*` or `UNNEST` of a struct: the step runs its native query without captured row witnesses, and lineage reports this limitation for its cells.
- Indistinguishable duplicate occurrences in a composed CTE/derived projection when no original row witness was captured. Use separate pipeline nodes to capture each stage's witnesses.

The response sets `complete: false` and identifies the unsupported step. The UI shows a coverage warning instead of presenting a partial search as complete. An unsupported construct does not modify the computed query values.

## Recalculation and stale results

A configuration edit or a manual recomputation invalidates the affected old generation. Pending lineage is interrupted, late responses are discarded, and further navigation is disabled. Recalculation does not automatically replay an explanation on the same row number. Select a cell explicitly after a valid replacement appears.

Failed recomputation retains the previous preview as stale, with its original SQL and execution metadata. It has no lineage.
