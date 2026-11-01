# Automate Jobs

Launch approved project versions from an orchestrator, wait for their results, cancel
them and collect their logs. The `duckpad run` command does all of this in one line
and exits with a code schedulers act on. It is a client of the stable `/api/v1` API,
which Airflow, Control-M, cron and CI can also call directly. The authenticated
OpenAPI description is available at `/api/v1/openapi.json`. Other API routes serve
Duckpad's interface and are internal contracts.

## Prepare a Job and a token

1. Create an accepted tag from project history or a successful run. A project admin
   opens **Jobs**, creates a Job with a stable slug, selects its environment and
   chooses that tag. A tag Job keeps the commit recorded at creation or promotion,
   even if the tag later moves. A branch target resolves its head at each launch
   and is useful for acceptance runs.
2. For a shared scheduler, an instance admin creates a service account in
   **Instance settings → Users and permissions**, then gives it **Operator** access
   in the project's settings. A Reader can inspect Jobs, runs and logs; Operators
   can also launch and cancel Jobs. Editors and admins inherit those rights.
3. Create a named token for that service account in its account administration.
   People can create their own tokens in **User settings → API tokens**. Copy the
   token when it is shown: only its hash is stored. Set an expiration if needed,
   store it in the orchestrator's secret store and revoke it when no longer used.

Service accounts cannot sign in interactively. Tokens use the account's current
project permissions, so revocation or an access change applies to subsequent
requests. Send tokens in `Authorization: Bearer …`; session authentication is also
supported. Browser writes must come from the same origin.

Jobs execute in internal read-only worktrees. Creating or promoting a Job confirms
its environment for API launches; the browser's run confirmation is not needed.
Only project admins can configure or promote Jobs. See [Version control](GIT.md)
and the [access matrix](INSTALLATION.md#accounts-and-project-access).

## Run a Job from the command line

`duckpad run` launches a Job, prints its progress, waits for the outcome and exits
with a code your scheduler can act on. It ships with the `duckpad` package and uses
only the Python standard library: it loads neither DuckDB nor the server and starts
in about a tenth of a second.

```bash
export DUCKPAD_SERVER=https://duckpad.example.com
# DUCKPAD_TOKEN is supplied by your secret store.
duckpad run --job sales-daily-prod --timeout 2h
```

Without `DUCKPAD_SERVER` or `--server`, the command targets the local instance at
`http://127.0.0.1:8765`: on the machine that runs `duckpad start`, a token is enough.

| Option | Effect |
| --- | --- |
| `--job SLUG` | Job to launch (required) |
| `--server URL` | Duckpad address, instead of `DUCKPAD_SERVER` |
| `--token-file PATH` | Read the token from a file, instead of `DUCKPAD_TOKEN` |
| `--detach` | Print the run ID as soon as the run is accepted, then exit with 0 |
| `--timeout DURATION` | Cancel the run after a duration such as `45s`, `90m`, `2h` or `1h30m` |
| `--source`, `--reference` | Trigger recorded on the run; `cli` and no reference by default |
| `--idempotency-key KEY` | Launch key; by default, a new key for each invocation |

The token is never accepted as an argument, because process lists show arguments to
other users of the machine. The command prints the run ID, its tag, commit and
environment, a line each time the run status or node counts change, then the run's
[text log](#wait-cancel-and-read-logs). Errors and retries go to standard error.

| Exit code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Failed |
| 2 | Partial failure |
| 3 | Canceled or interrupted, including by SIGTERM or SIGINT |
| 4 | Refused because the Job is already running; retrying later is safe |
| 5 | Request refused: authentication, permission, unknown Job or invalid input |
| 6 | Timeout reached; the run was canceled |
| 7 | Server unreachable |

- **Network errors** and 5xx responses are retried for two minutes. A launch retry
  reuses the idempotency key, so a lost response never starts a second run. After a
  launch, exit code 7 means the run may still be running.
- **SIGTERM and SIGINT** (a Control-M kill, an Airflow timeout, Ctrl+C) make the
  command request cancellation, wait up to two minutes for the run to stop, print
  its log and exit with 3. An expired `--timeout` does the same and exits with 6. A
  second signal stops the wait.
- **Redirects are refused**, so the token is never sent to another address: use the
  final HTTPS address. `HTTPS_PROXY`, `NO_PROXY` and `SSL_CERT_FILE` are honored.

### Airflow

Store the token as the password of an Airflow connection, here `duckpad_prod`; Airflow
masks it in task logs. The key includes the attempt number, so an Airflow retry
starts a new run, while the command's own retries reuse the key.

```python
from datetime import timedelta

from airflow.providers.standard.operators.bash import BashOperator  # Airflow 2: airflow.operators.bash

sales_daily = BashOperator(
    task_id="sales_daily",
    bash_command=(
        "duckpad run --job sales-daily-prod --source airflow"
        " --reference '{{ dag.dag_id }}/{{ run_id }}'"
        " --idempotency-key '{{ dag.dag_id }}:{{ task.task_id }}:{{ run_id }}:{{ ti.try_number }}'"
    ),
    env={"DUCKPAD_SERVER": "https://duckpad.example.com", "DUCKPAD_TOKEN": "{{ conn.duckpad_prod.password }}"},
    append_env=True,
    execution_timeout=timedelta(hours=2),
)
```

When `execution_timeout` expires, Airflow sends SIGTERM: the command cancels the run
before the task fails. Use `max_active_runs=1` on the DAG, since a Job admits one
run at a time.

### Control-M

Run the command in an OS job with a token file that only the agent's user can read
(`chmod 600`). Control-M variables fill the trigger and the key; `%%RUNCOUNT` changes
on each rerun, so a rerun starts a new run. The job's command line:

```bash
duckpad run --job sales-daily-prod --timeout 2h --server https://duckpad.example.com --token-file /opt/controlm/duckpad/sales.token --source control-m --reference '%%JOBNAME/%%ORDERID' --idempotency-key 'ctm:%%ORDERID:%%RUNCOUNT'
```

Add an **On/Do** action for `COMPSTAT=4` (Job already running) that reruns the job
after a delay. Other non-zero codes end the job as Not OK.

### cron

cron starts commands with a minimal `PATH`: call the command by its full path, and
keep its output for diagnosis.

```text
0 2 * * * DUCKPAD_SERVER=https://duckpad.example.com /opt/duckpad/bin/duckpad run --job sales-daily-prod --token-file /etc/duckpad/sales.token --source cron --timeout 2h >> /var/log/duckpad/sales-daily.log 2>&1
```

## Without installing Duckpad

A scheduler can also call the API directly: see the `curl` examples below. It then
takes on what `duckpad run` does: wait after the **202** response, cancel the run
when the task is killed (otherwise the run continues and its exports write), retry
with the same idempotency key, and tell **409** `job_busy` apart from refusals.

With PowerShell, for example in the Windows Task Scheduler:

```powershell
$ErrorActionPreference = "Stop"
$auth = @{ Authorization = "Bearer $env:DUCKPAD_TOKEN" }
$run = Invoke-RestMethod -Method Post -Uri "$env:DUCKPAD_SERVER/api/v1/jobs/sales-daily-prod/runs" `
  -Headers ($auth + @{ "Idempotency-Key" = "sales-daily:$(Get-Date -Format yyyy-MM-dd)" }) `
  -ContentType "application/json" -Body '{"trigger":{"source":"task-scheduler"}}'
do {
  $run = Invoke-RestMethod -Uri "$env:DUCKPAD_SERVER/api/v1/runs/$($run.id)?wait=30" -Headers $auth
} while ($run.status -in "preparing", "running", "canceling")
Invoke-RestMethod -Uri "$env:DUCKPAD_SERVER/api/v1/runs/$($run.id)/log" -Headers $auth
if ($run.status -ne "success") { exit 1 }
```

With Airflow's HTTP provider, put the server in an HTTP connection and the token in
its Extra field as `{"Authorization": "Bearer dpk_…"}`. `HttpOperator` succeeds as
soon as the run is accepted, so always follow it with a sensor:

```python
from airflow.exceptions import AirflowFailException
from airflow.providers.http.operators.http import HttpOperator
from airflow.providers.http.sensors.http import HttpSensor


def finished(response):
    status = response.json()["status"]
    if status in ("failed", "partial_failure", "canceled", "interrupted"):
        raise AirflowFailException(f"Duckpad run {status}")
    return status == "success"


launch = HttpOperator(
    task_id="launch_sales_daily",
    http_conn_id="duckpad_prod",
    method="POST",
    endpoint="api/v1/jobs/sales-daily-prod/runs",
    headers={"Content-Type": "application/json", "Idempotency-Key": "{{ run_id }}:{{ ti.try_number }}"},
    data='{"trigger": {"source": "airflow", "reference": "{{ run_id }}"}}',
    response_filter=lambda response: response.json()["id"],
)
wait = HttpSensor(
    task_id="wait_sales_daily",
    http_conn_id="duckpad_prod",
    endpoint="api/v1/runs/{{ ti.xcom_pull(task_ids='launch_sales_daily') }}",
    response_check=finished,
    poke_interval=30,
    mode="reschedule",
)
launch >> wait
```

Neither operator cancels the run when Airflow kills the task, and a busy Job fails
the launch task like any other refusal.

## Launch and follow a run

These examples use `curl` and `jq`. Load `DUCKPAD_TOKEN` from your secret store;
never put a literal credential in a script, source control or a log. The examples
pass the header through standard input to keep it out of process arguments.

```bash
export DUCKPAD_SERVER=https://duckpad.example.com
# DUCKPAD_TOKEN is supplied by your secret store.
duckpad_api() {
  printf 'header = "Authorization: Bearer %s"\n' "$DUCKPAD_TOKEN" |
    curl --silent --show-error --fail-with-body --config - "$@"
}

duckpad_api "$DUCKPAD_SERVER/api/v1/jobs"
duckpad_api "$DUCKPAD_SERVER/api/v1/jobs/sales-daily-prod"

run=$(duckpad_api \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: sales-daily:2026-10-31:attempt-1' \
  -d '{"trigger":{"source":"airflow","reference":"sales_daily/scheduled-2026-10-31"}}' \
  "$DUCKPAD_SERVER/api/v1/jobs/sales-daily-prod/runs")
id=$(printf '%s' "$run" | jq -r .id)

duckpad_api "$DUCKPAD_SERVER/api/v1/runs/$id?wait=30"
duckpad_api "$DUCKPAD_SERVER/api/v1/runs/$id/log"
```

A launch returns **202 Accepted**, including when a retry retrieves an existing
run. A run may already be finished when the response arrives. Its representation
contains no captured SQL, connection settings or variable values:

```json
{
  "id": "run_example",
  "job": "sales-daily-prod",
  "status": "preparing",
  "tag": "sales/2026.10.31",
  "commit": "9f3c…",
  "environment": "prod",
  "started": "2026-10-31T02:00:04Z",
  "finished": null,
  "nodes": {
    "total": 12, "success": 0, "failed": 0, "running": 0,
    "pending": 12, "blocked": 0, "canceled": 0, "interrupted": 0
  },
  "trigger": {"source": "airflow", "reference": "sales_daily/scheduled-2026-10-31"},
  "requester": {"id": "user_example", "username": "scheduler", "token_name": "Airflow"},
  "links": {
    "self": "/api/v1/runs/run_example",
    "log": "/api/v1/runs/run_example/log",
    "cancel": "/api/v1/runs/run_example/cancel"
  }
}
```

The optional launch body is `{}` or `{"trigger":{"source":"…","reference":"…"}}`.
`source` is required when a trigger is supplied (1–128 characters); `reference`
is optional (up to 2048 characters). The trigger is caller-declared metadata, while
`requester` records the authenticated account and token name. Unknown fields are
rejected: selecting a version or supplying runtime variable values at launch is
not supported. `tag`, `trigger`, `requester` on older runs, and `finished` while
active can be `null`.

A Job response contains its `slug`, `name`, `description`, `project`, `target`,
`environment`, `scope` and `last_run` (the run representation above, or `null`).
The list route returns an array of only the Jobs visible to the caller.

## Wait, cancel and read logs

`GET /api/v1/runs/{id}?wait=N` returns immediately for a terminal run. Otherwise it
waits up to N seconds, returning early when execution finishes; N must be between
0 and 60. Omit it for an immediate snapshot. Waiting releases server worker
threads between reads. A timeout returns **200** with the current active status;
it does not cancel execution. Repeat until a terminal status appears:

```bash
while :; do
  run=$(duckpad_api "$DUCKPAD_SERVER/api/v1/runs/$id?wait=30") || exit 1
  status=$(printf '%s' "$run" | jq -r .status)
  case "$status" in
    preparing|running|canceling) ;;
    success) break ;;
    *) duckpad_api "$DUCKPAD_SERVER/api/v1/runs/$id/log"; exit 1 ;;
  esac
done
```

Active statuses are `preparing`, `running` and `canceling`. Terminal statuses are
`success`, `failed`, `partial_failure`, `canceled` and `interrupted`. An instance
restart marks unfinished runs `interrupted`; Duckpad does not retry them.

```bash
duckpad_api -X POST "$DUCKPAD_SERVER/api/v1/runs/$id/cancel"
duckpad_api "$DUCKPAD_SERVER/api/v1/runs/$id?wait=30"
```

Cancellation returns **200** with the run's current state. Repeating it, including
after completion, is harmless. Cancellation is a request, not proof that an
external write was undone: an export can have a partial or unknown outcome.

The `/log` route returns a **text/plain** snapshot, available while active and after
completion. It includes node statuses and timing, retained execution messages,
errors, export outcomes and the current run outcome. Re-read it for progress; it
is not a streaming endpoint. It uses the persisted, secret-redacted run data and
retains the execution service's message limits. Historical Job runs stay readable
after the Job is deleted. Ad hoc interface runs are outside the v1 API.

## Retry safely

Provide an optional `Idempotency-Key` header (1–256 characters) for any launch that
might be retried after a network failure. Keys are scoped to a Job and retained
for **seven days after acceptance**. Within that period:

- The same key and body return the original run with its current status and
  original requester, even if it finished or another run is now active.
- The same key with a different body returns **422** / `invalid_request`.
- Object property order does not matter; omitted optional fields and their
  default values are equivalent.
- A refused launch does not consume the key. After a **409** / `job_busy`, wait
  for the active run to finish and retry with that key.

Concurrent identical retries admit one run. The run and key are committed together
before execution starts, so a lost HTTP response does not cause a second export.
After seven days, the key can start a new run. Deliberate reruns use a new key,
for example the scheduler's execution ID plus attempt number. A Job admits one
active run at a time and never queues requests; different Jobs can run in parallel.

## Handle errors

Errors use `{"error":"Human-readable explanation","detail":{"code":"…"}}`.
Use the HTTP status and `detail.code` in automation rather than matching the
message. Additional detail can include validation errors or an active run ID.

| HTTP status | `detail.code` | Meaning |
| --- | --- | --- |
| 401 | `unauthenticated` | Missing, invalid, expired or revoked credentials |
| 403 | `forbidden` | Insufficient project role, or a cross-origin browser write |
| 404 | `job_not_found`, `run_not_found` | Unknown resource or one the caller cannot see |
| 409 | `job_busy` | An execution is active; `detail.run` contains its ID |
| 409 | `target_unavailable` | The target commit or branch, or required environment, is unavailable |
| 422 | `invalid_project` | The Job's project version or execution scope is invalid |
| 422 | `invalid_request` | Invalid input, wait value or idempotency key reuse |

Refused launches create no run record; busy refusals appear in the server log.
Check a failed run's `/log` before scheduling another attempt, especially when it
contains exports to external systems.
