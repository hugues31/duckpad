# Data partitions

Partitions run the same SQL pipeline once for each typed key from a control node.
Declare one dimension in `flow.json`, then filter a source output by its key column.
Downstream nodes inherit that key. Shared lookups run once.

![Selecting a partition and inspecting its retained result](images/partitions.png)

Open **Partition → Partition settings** to choose the control node, output, key
column, type and optional attribute columns. The control output is read in full
at launch; null or duplicate keys and incompatible types stop partition consumers.
Use text for numeric identifiers that cannot round-trip exactly through a browser.

In the node inspector, set **Partition key column** for each filtered output.
Use `{{ partition }}` or `{{ partition.attribute }}` in expression parameters;
use `{"$partition": true}` or `{"$partition": "attribute"}` for a whole typed
parameter. SQL values are bound parameters, including quoted keys. A filter
applies to the declared output's query, so place it at the source to benefit from
scan pushdown. The SQL tab shows the bound predicate for a selected key and a
parameterized plan for **All**.

**Collect all input partitions** leaves the partitioned zone. Its inputs retain
the latest successful output for every required key on disk. Collection preserves
duplicates, manifest order and each output's observed row order. A missing, stale
or failed key prevents collection; Duckpad never silently executes a partial union.
An empty manifest produces typed empty inputs, so a collector's `count(*)` returns
zero without reading partition source rows.

The global selector and the Results partition strip change inspection only.
Search and page through keys and attributes, filter by validity, then select a key
to inspect Data, Columns, SQL and Log. Shared nodes and collectors retain their
global meaning. **All** inspects the available retained outputs and displays an
incomplete banner when some previews are unavailable. It does not refresh sources.

By default, intermediate previews keep the last executed key within a 1 GiB
budget. The settings also allow all keys within that budget, or no intermediate
previews. Mandatory collector inputs use separate retention. An evicted preview
still has run evidence; explicitly run that key when fresh inspection is needed.
Neither Git nor project ZIPs contain manifests, selected keys or retained data.
Each branch and environment has its own manifest and results.

**Run pipeline** recalculates the list and runs every key. **Run with options…**
offers **Failed**, **Missing** and **Selected keys**, plus a parallelism limit and
failure policy for this run. Targeted node runs reuse the retained list; selecting
a key before running a node limits that launch to the key. Protected environments
confirm the source, selection and policies before admission.

Parallel keys share one SQL session's thread scheduler, memory limit and spill
directory. The effective concurrency cannot exceed its thread budget. **Stop**
stops admitting new keys after an error and lets already active keys finish;
**Continue** attempts the remaining keys. File destinations must be distinct
across the whole manifest. Remote writes remain serial even with parallel keys.

Retrying **Failed** recalculates the list and shared inputs, then runs the currently
failed keys. Successful exports with the same key and computation fingerprint are
skipped, including exports that succeeded earlier within a failed key. Unknown
write outcomes after cancellation or a crash need care: retrying a non-idempotent
external append can duplicate rows. A retry does not replay a past source snapshot.
New keys are **Missing**; stale keys remain visible and need **All** or an explicit
selection. History pages keep the original manifest, attempts and export outcomes.

Jobs accept the same options through `POST /api/v1/jobs/{slug}/runs`. The body is
part of the idempotency identity. Readers can page through
`GET /api/v1/runs/{id}/partitions` and filter the text log by opaque `partition_id`;
launch and retry require the existing Operator role. Read contexts use
`manifest=<id>&partition_id=<id>` or `manifest=<id>&partition_mode=all`.

```sh
duckpad run daily-orders --partitions failed
duckpad run daily-orders --partition-keys keys.json --partition-parallelism 2
```

`keys.json` contains a typed array such as `[{"type":"text","value":"batch-012"}]`.
The selector flags are mutually exclusive. Existing `--job`, wait, cancellation,
detach, authentication and terminal exit codes remain supported; partial failure
returns exit code 2. Progress reports the phase and completed/failed key counts.
