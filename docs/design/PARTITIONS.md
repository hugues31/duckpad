# Data partitions: design decisions

Implemented. See [Data partitions](../PARTITIONS.md) for declarations, controls,
API and CLI examples. These choices were accepted on 1 November 2026.
Live OraDuck/Oracle predicate-pushdown and transfer-volume validation remains
pending; local Parquet checks do not replace it.

## Model

One dimension in `flow.json` declares a typed control output and attributes.
Output boundaries filter by a key column; downstream nodes inherit the key.
Components propagate the same execution context. Scalar variables and partitions
share value-source selection and typed rendering; partitions never mutate scalar
declarations in a loop.

Keys and attributes freeze for a run. Null or duplicate keys and incompatible
types reject the manifest. Included producers run once before consumers. Targeted
runs reuse a retained manifest or calculate it when none exists. A producer refresh
failure does not substitute an older manifest within that run.

## Execution and memory

Shared nodes execute once. Each key runs its dependency graph; scratch tables and
lineage state are released after their last consumer. At parallelism 1, the intended
working-set bound is shared data plus one partition and bounded I/O buffers.
Manifest metadata grows with key count. Collector queries and large shared inputs
have separate costs and may spill.

Parallel keys use cursors in one worktree/environment DuckDB session, sharing its
thread and memory limits. Concurrency is capped by the thread budget. Increasing
parallelism allows several partition working sets. Remote writes remain serial.

An empty manifest produces typed empty inputs without reading partition data or
running per-key exports. Schema binding may inspect metadata. Collectors execute
normally: `count(*)` returns zero and an export can write an empty report.

## Collection, storage and retention

A collector requires a valid artifact for every key in the frozen manifest,
including reused keys on a selective run. It preserves duplicates and orders rows
by manifest ordinal, then observed row ordinal within the output. Incomplete or
schema-incompatible inputs block collection. An incomplete **All** preview cannot
substitute for a complete collector input.

Collector inputs retain the latest successful generation of each key on disk.
They are mandatory and outside the optional preview budget. Intermediate previews
can retain none, the last N keys or all keys within a byte cap; the default is the
last key within 1 GiB. Oversized optional outputs retain evidence but no partial
preview. Retention changes availability, not computation validity.

Artifacts use generated IDs, never keys as paths. Publication registers complete
immutable files and schema metadata. Cleanup respects readers and active runs.
Run history stores manifests, attempts, timing and export outcomes separately
from retained rows. Ordinary in-memory results and computed scalar caches do not
become persistent through this mechanism.

### Optional-write cost

Keeping the last successful preview can require writing a full intermediate
before the next key: that next key might fail. Holding both keys in memory or
rerunning sources would break the intended lifetime rules. Older parallel writes
can be skipped once enough newer successful keys are retained. Optional writes
stop at their byte cap.

## Validity, failure and retry

Per-key fingerprints include executable configuration, the typed key, attributes
actually used and dependencies. Collectors also include the ordered manifest.
Changing key order affects collection; changing an unused attribute does not
invalidate computations. Attempt outcome and retained-result validity are separate.

Stop-on-error stops admitting keys and lets active keys finish; continue attempts
the rest. Within a key, independent branches can finish after another fails.
Collection remains blocked when any required input is unavailable.

Retries are new launches against current sources. Successful exports with matching
key and computation fingerprints are skipped; unknown external-write outcomes
cannot promise exactly-once retry. Historical evidence is not a source snapshot.

## Lineage

Collected rows retain their typed key, producing run and occurrence. Duplicate
business rows remain distinct. Detailed explanations use immutable intermediate
generations that are still available. **Run this key to explain** produces new
evidence without rerunning downstream exports; it does not reconstruct old data.

## Remaining scope

Live Oracle pushdown evidence is still required. Accepted but not implemented:
byte estimates from prior runs (mandatory and optional separately, **Unknown**
before a first run); instance storage limits, where a required artifact that does
not fit fails its partition and never deletes an input in use; a warning when a
late boundary may compute a large shared input; an **Output filter; source
pushdown unavailable** status; a warning for a dimension without consumers.

Outside this version: multiple dimensions, dependencies between keys, generated
time ranges, repeated components, distributed workers, automatic retries, retries
replaying a past manifest, source snapshots, exactly-once remote writes and
caller-supplied variable overrides.
See the [automation proposal](JOB_AUTOMATION.md#delivery-plan) for future launch
values. The original detailed proposal and mockups remain in Git history.
