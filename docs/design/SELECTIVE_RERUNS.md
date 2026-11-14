# Selective reruns: UI exploration

Proposal, not implemented execution behavior. The goal is to iterate on a flow
without repeatedly loading unchanged Oracle or PostgreSQL inputs. The companion
[interactive mockup](../../frontend/public/assets/design/selective-reruns.html)
compares three interfaces using synthetic data. After a frontend build, open
`/assets/design/selective-reruns.html` on the application. It also opens directly
as a local HTML file. Every action is simulated; it never calls the API.

## What Duckpad already has

Reviewed against `b08ff7fe`:

- **Run all** in `frontend/src/FlowToolbar.tsx` and **Run with ancestors** in the
  inspector. Canvas selection exists, but there is no multi-target run contract.
- `execution/launches.py:launch_scope` selects the whole flow or a node/component
  and its ancestors. `ancestors=True` excludes the selected node for draft
  previews; it does not mean "reuse ancestors."
- Results already have a physical table, a configuration fingerprint, input
  generation IDs, a creation time and an originating run (`datasets.py`). The
  existing Valid badge means configuration-compatible, not verified against the
  current contents of the remote database.
- `LaunchPlanner.prepare` marks the requested scope and its descendants stale.
  `execution/nodes.py` requires ancestors to succeed in this run and reads from
  `execution.published`. Consequently, keeping tables in memory does not yet
  avoid executing their source queries on the next run.
- Fingerprints, environment/worktree isolation, atomic publication, retained
  stale results, lineage cancellation and execution history provide much of the
  foundation. Computed variables, partition manifests and stored partition
  artifacts also participate; they cannot be treated as ordinary canvas edges.

This is a planner change with a small UI, not just a new button. See the current
[execution contract](../ARCHITECTURE.md#execution-service) and
[result lifetime](../RESULTS.md#result-lifetime).

## Three UI directions

| Direction                                   | What the user sees                                                                                                                         | Benefit                                                                                   | Cost                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **A. Run button with a menu — recommended** | **Run changes** plus **Recompute with loaded sources** and **Reload sources and run** in its menu. With selected nodes, **Run selection**. | One click for everyday iteration; a deliberate action to read the remote databases again. | The summary must make reused data visible.                                                                   |
| **B. A short launch dialog**                | Scope, then **Reuse available results** or **Reload sources**, then a plan and **Run**.                                                    | Makes the consequences explicit; accommodates multiple selections and writes.             | An extra dialog on every run. Prefer it as an optional plan review rather than the default.                  |
| **C. Keep individual sources**              | **Keep loaded data** on each source, with its load time and **Reload** action.                                                             | Useful when one large input is stable and another must be refreshed often.                | Persistent switches to remember; pinning cannot override invalid data. Too much state for the first version. |

The mockup has the same six-node graph in all three directions. Filter and
Revenue can be selected individually or together. Clicking nodes toggles the
selection, so the reviewer can compare the exact same task across options.
The source row counts are illustrative, not benchmarks.

## Recommended first interface

Keep two concepts separate: **what to run** and **whether to reload data**.
Avoid exposing "cache," "TTL," "fingerprint" or "invalidation" in the controls.

Global button:

```text
[ Run changes ] [ v ]
  Run changes                    Reuse compatible results
  Recompute with loaded sources  Run transformations again
  Reload sources and run         Read remote data again

3 to run · 3 reused · 0 source reads · 1 export write
Sources loaded at 10:42 · Remote changes are not checked
```

Selecting one or more nodes reveals a contextual action:

```text
2 selected                 [ Run selection ]
                           [ Include downstream: off ]
Valid inputs will be reused. Missing or changed inputs will be computed.
```

The global action still addresses the whole flow; selection must not silently
change its scope. The mockup's explicit scope selector stands in for the future
contextual toolbar. Reuse the existing selection behavior and partition menu;
do not add a second competing arrow beside Run all. A unified run menu should
group data policy separately from partition selection.

Use textual states as well as color: **Loaded at 10:42**, **Reused**, **To run**,
**Needs rerun**, and **No result**. A reused result keeps its original load time,
run, test outcome and generation; reuse is not a new successful test execution.
History should say "3 executed, 3 reused" and link reused results to their
originating runs. Estimates use prior durations and say Unknown when absent.

## Proposed behavior

| Action                        | Reuse                                        | Execute                                                                             |
| ----------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Run changes                   | Eligible sources and transformations         | Missing or changed results, their affected consumers in scope, and requested writes |
| Recompute with loaded sources | Eligible source snapshots                    | All transformations and writes in the chosen scope                                  |
| Reload sources and run        | Nothing in the required scope                | Sources, transformations and writes, in dependency order                            |
| Run selection                 | Eligible ancestors, including remote inputs  | Selected nodes even if valid, plus prerequisites that need computation              |
| Include downstream            | Eligible ancestors of the expanded selection | Selected nodes and their descendants; shared prerequisites run once                 |
| Reload one source             | Other eligible inputs                        | That source only; mark its descendants stale until the user runs them               |

If Filter is edited, **Run changes** reuses Orders, Customers and Join, then runs
Filter, Revenue and Export. **Run selection** on Filter only runs Filter; Revenue
and Export stay stale. Selecting Filter and Revenue runs both once and leaves
Export stale. With **Include downstream**, Export is also run and the plan shows
its external write. A second unchanged **Run changes** reuses all five data
results but still executes the requested export; a flow with no writes can say
"Nothing to run."

After a backend restart, missing in-memory inputs must be loaded again. Changing
the environment or worktree selects that context's results, never another
context's tables. Missing eligible persisted partition artifacts must also be
computed. The UI must show the resulting source reads before launch; a stale
snapshot cannot silently substitute for a failed refresh.

### Freshness and correctness

Duckpad cannot infer that an Oracle/PostgreSQL table is unchanged from an
unchanged SQL query. Reuse means **use the snapshot already loaded**, explicitly
showing its age. Automatic freshness checks, connector-specific watermarks, CDC
and expiry policies are outside this proposal. Reload is always available.

A reusable output must exist, be valid for the captured configuration, have all
required ports, and reference the current input generations. SQL, parameters,
resolved variables, connections, runtime configuration and partition keys remain
part of validity. Layout, names and documentation do not force computation.
Recomputing a source must invalidate its consumers even when the configuration
fingerprint is identical: the data generation changed.

Exports and other external writes are never skipped because their previous
execution succeeded. Show them separately in the plan and preserve the existing
production confirmation. Volatile SQL, reads hidden in custom code, and Python
nodes need an explicit reuse eligibility contract; default to execution when
purity cannot be established. Source reuse itself is an explicit user choice
to keep a snapshot, not a claim of deterministic remote data.

Multi-output nodes publish and reuse a complete output set. Component selection
expands to its internal nodes and boundaries; overlapping selections deduplicate.
Failed, canceled, incomplete or stale results are not reusable, even if old rows
remain inspectable. A refresh failure blocks dependent nodes. Independent valid
branches can proceed. Never repeat an external write as an automatic retry.

### Implementation boundary after choosing a direction

1. Add a shared planner for target IDs, downstream scope and reuse policy. It
   returns execute/reuse/blocked decisions with reasons, source reads and writes.
   A displayed plan is advisory: admission must recheck after saving, within the
   worktree reservation, so edits or evictions cannot turn it into a stale plan.
2. Seed execution inputs with the exact reused generations. Replace the current
   blanket invalidation with invalidation of recomputed nodes and their affected
   descendants. Protect reused tables and provenance dependencies until readers
   and the run release them; adjust publication/retirement accordingly.
3. Record reuse distinctly in history and progress. Teach dependency checks that
   a validated reuse satisfies an input, while a skipped/failed node does not.
   Keep cancellation, permission checks, connection grants and atomic publication.
4. Start with manual, unpartitioned SQL flows and explicit source reuse. Keep Jobs,
   APIs and partition execution on their existing behavior until their contracts
   are covered. Disable reuse with an explanation for unsupported scopes, rather
   than pretending computed variables, Python or partition artifacts are safe.
5. Add the compact menu and contextual selection action once the planner reports
   trustworthy decisions. Review the API default independently to avoid changing
   automation semantics by changing a button label.

Acceptance examples for that future implementation: edit a downstream filter
without issuing a remote query; select two nodes sharing one ancestor; force one
source reload and stale only its descendants; restart with no in-memory tables;
change SQL, connection or environment; fail/cancel a refresh without fallback;
keep lineage correct across reused generations; report and execute exports;
reject unsafe reuse for unsupported scopes. The mockup illustrates the UI only
and is not evidence that those engine cases are implemented.
