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
