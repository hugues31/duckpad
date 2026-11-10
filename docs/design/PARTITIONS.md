# Data partitions: remaining proposals

See [Data partitions](../PARTITIONS.md) for the implemented behavior.

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
values.
