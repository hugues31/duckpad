# Execution-service decision

The MVP uses a small embedded execution service. APScheduler 3.x is the preferred future adapter for requesting scheduled runs. Neither a scheduler nor a queue replaces Duckpad's worktree admission, DuckDB contexts, cancellation or persistent execution history. No schedules, webhooks, retries or missed-run replay are enabled in this MVP.

## Prototype evidence

The recorded result is `validation/jobs.json`, using Huey 3.5.3, APScheduler 3.11.3, SQLAlchemy 2.1.6 and DuckDB 2.0.0. The prototype script was removed once the decision was made; it remains available in the Git history.

| Criterion | SqliteHuey | Embedded service with future APScheduler adapter |
| --- | --- | --- |
| Dynamic schedule management | Task dispatch and ETA scheduling are available; arbitrary editable calendar definitions need a separate adapter/policy | Prototype creates, modifies, reschedules and deletes a job at runtime |
| SQLite restart behavior | Prototype confirms queued work survives reopening; automatic consumption would need an explicit no-replay policy | Prototype confirms schedule definitions survive restart, starting paused without dispatch |
| One run per worktree | Queue dispatch alone does not provide this; admission must happen before enqueuing | Shared service rejects UI, API, schedule-shaped and webhook-shaped requests while occupied |
| Live memory contexts | Thread workers could share the owner process; separate processes cannot reuse the same in-memory database | Worker cursors use the owning worktree/environment connection; previews succeed afterward |
| Cancellation | Revoking a queued task does not interrupt active DuckDB SQL | Engine sets a token and interrupts the cursor; no later node starts |
| Shutdown/restart | Persistent jobs require extra care to avoid repeating external writes | Durable run history survives; datasets and active work are not restored or retried |
| Other worktrees | Requires the same application-level admission logic | Prototype admits another worktree while the first is occupied |

The prototype does not implement a custom calendar scheduler. It tests the candidates' relevant storage/lifecycle behavior and the application boundary, supplemented by acceptance tests for real active-query interruption and simultaneous requests. The scheduling library is a development dependency for this comparison, not an MVP runtime requirement.

## Future integration boundary

A schedule callback should resolve the running application's execution service and submit a worktree ID, environment, optional node, and trigger identity. It must not serialize DuckDB connections or credentials, reuse a stale launch snapshot, bypass admission, or place a rejected request in a deferred queue. Run records remain the authoritative application history rather than task-result storage.

Before enabling automation, define time zones and DST, missed occurrences, rejected-trigger outcomes, webhook authentication/idempotency, and retention policies. Interrupted runs and future occurrences are separate events. The MVP deliberately has no implicit replay policy for external writes.

References: [APScheduler 3.x user guide](https://apscheduler.readthedocs.io/en/3.x/userguide.html), [SqliteHuey API](https://huey.readthedocs.io/en/latest/api.html#SqliteHuey), [DuckDB Python interruption](https://duckdb.org/docs/2.0/clients/python/reference/#duckdb.DuckDBPyConnection.interrupt).
