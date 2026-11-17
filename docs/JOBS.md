# Jobs and scenarios

Open **Jobs** from the project toolbar to run a reviewed version in a chosen
environment, independently of your working branch. A Job decides what runs: a
version, an environment and a scope. A [scenario](#scenarios) decides when Jobs
run and in which order, which values a launch can set, and who hears about the
outcome.

## Run a Job

Readers can inspect Jobs, their logs, results and version history.
Operators and higher roles can **Run Job**, cancel an active run, or run it again.
A protected environment asks for confirmation before launch. Each Job accepts one
run at a time: a busy launch is refused with the active run ID, without queuing or
retrying it. Different Jobs can run in parallel.

## Create a Job

Project admins choose **New Job**, then enter a name. Duckpad suggests a permanent
instance-wide slug (lowercase letters, digits and hyphens), which can be edited.
Choose the environment and version, then the **Scope**: **Whole project** runs
every node, while **One node** opens a searchable list of the version's nodes and
runs the chosen one with the nodes it depends on. Projects without tags start with **Branch** and
the main branch, so a Job can be created without leaving the form.
Choose a tag to pin its current commit, or a branch for acceptance runs that should
resolve the branch head at each launch. Uncommitted edits are never a Job target.
After creation, **Run from an API or scheduler** in the Job details shows a curl
call and a cron example for this server. Use an API token with run permission, or
a [scenario](#scenarios) to schedule it inside Duckpad.

A Job run uses the versioned `variables.json` values for its environment, unless
a scenario sets [launch values](#create-a-scenario) for that run.

## Change version and roll back

A tag Job keeps its pinned commit even if something outside Duckpad moves the tag.
The Jobs page warns about the mismatch; it never silently follows the moved tag.
**Change version** first opens **Compare versions**, including variable value
changes, and only then enables **Use this version**. The audit records who changed
it, when, and the old and new tags and commits. To roll back, expand **Version
history** and choose **Review this version** beside an earlier tag, then compare
and confirm. If the Job or reference changes during review, compare again.

## Results and history

**Open results** opens the Job's internal checkout with flow, code, previews and
lineage in read-only mode, including for administrators. It stays on the last run's
commit until another launch; changing the target does not relabel existing results.
Internal checkouts never appear in the branch selector. Result availability follows
the usual execution-context lifetime. **Recent runs** and **History** retain the
Job name, requested tag, executed commit, requester, token name and node logs.
Deleting a Job keeps its run history and results available in **History**. The
**Open results** link in a historical Job run still opens its retained checkout.

For external schedulers, API tokens and the `duckpad run` command, see
[Automate Jobs](AUTOMATION.md).

## Scenarios

Scenarios appear above the Jobs on the **Jobs** page. Readers see their
definition and history, Operators run and stop them, and project admins create,
edit, disable and delete them.

### Create a scenario

Project admins choose **New scenario**, name it and keep or edit the suggested
permanent, instance-wide slug, which the webhook URL uses. Then configure:

- **Steps**: the Jobs to run, one after the other; each step waits for its Job
  run to finish. From the second step on, choose when a step runs: **If previous
  steps succeeded**, the default; **If a previous step failed**, for example to
  refresh an alert table; or **Always**. A step runs its Job's current version,
  environment and scope, so promoting a Job changes what its scenarios run.
- **Launch values**: the ordinary project variables that a launch can set,
  chosen among those declared by the versions the steps run. A value applies to
  that run only, in every step whose version declares the variable;
  `variables.json` never changes. Without a value, the run uses the project's
  value. Run details show these values with the source *launch*, and results
  computed with them are fingerprinted like any other value.
- **Triggers**: Operators can always run a scenario manually. Add
  [schedules](#schedules), and turn on **Accept webhook deliveries** to accept the
  [webhook trigger](AUTOMATION.md#trigger-a-scenario-with-a-webhook).
- **Notifications**: destinations configured by an instance administrator, each
  with **On failure**, **On success** or **On every outcome**.

A disabled scenario keeps its definition and history; schedules and webhooks no
longer start it, but Operators can still run it. A Job used by a scenario cannot
be deleted until it is removed from that scenario.

### Schedules

A schedule is a cron expression evaluated in an IANA time zone, for example
`30 2 * * 1-5` in `Europe/Paris` for 02:30 on weekdays. Its five fields are the
minute, hour, day of month, month and day of week (0 or 7 is Sunday). Fields
accept `*`, values, ranges, lists, steps such as `*/15`, and English month and
day abbreviations; `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly` are
also accepted. When both day fields are restricted, a day matching either one
matches, as in standard cron. While you type, the form shows the next three
occurrences or explains the error.

- **Daylight-saving changes.** A time skipped when clocks move forward runs
  once, when the gap ends: on that day, 02:30 in Europe/Paris runs at 03:00. A
  time repeated when clocks move back runs once, at its first occurrence.
- **Restarts and missed occurrences.** Each schedule stores its next occurrence,
  so schedules survive restarts. An occurrence found up to two minutes late still
  runs. Occurrences missed for longer, while Duckpad was stopped, are not caught
  up: the history records one **Missed** entry with their number and the first
  of them, and the next occurrence runs normally.
- **Saving or enabling** a scenario plans its occurrences from that moment:
  occurrences that passed while it was disabled are neither run nor reported.

Scheduled runs are requested by the *schedule* service identity.

### Admission

A scenario has at most one active run, and it starts only while none of its Jobs
is running. Otherwise the launch is refused, without queuing, retrying or
replaying it: a person sees the error, while a refused schedule occurrence or
webhook delivery is recorded as **Rejected** in the history, with the run that
blocked it. Different scenarios and Jobs still run in parallel. A step whose Job
becomes busy or unavailable while earlier steps run is **Refused** and counts as
a failure.

A manual run asks for confirmation when a step runs in an environment that
requires it. Creating the scenario confirms these environments for its schedules
and webhook.

### Runs and history

A scenario run succeeds when every step that ran succeeded, and fails otherwise,
even if a step that runs after a failure then succeeds. **Stop** cancels the
active step and skips the remaining ones, **Always** steps included.

**Scenario runs** lists each run with its trigger, requester, duration and
outcome. Expand a run to see its launch values, each step's status, duration
and error, the notifications sent, and, for a refused or missed trigger, the
reason. **Run details** opens a step's Job run, and **Open results** its
read-only results. Step runs also appear in **History** as runs of their Jobs,
labeled with the scenario. A restart marks an active scenario run
**Interrupted** and does not resume it. Deleting a scenario deletes its history,
not the runs of its Jobs.

### Notifications

Instance administrators configure the SMTP server and named destinations in
**Instance settings → Notifications**: email recipients, or the URL of an
incoming webhook, such as a chat channel's. The SMTP password and webhook URLs
are encrypted like other instance secrets and never shown again; **Send a test**
checks a saved destination. **On failure** covers failed, interrupted, rejected
and missed runs, not cancellations.

Each delivery is attempted once, when the run ends, with a 10-second timeout,
and recorded in the run apart from its outcome: a failed delivery never changes
the run, is not retried and never reruns a Job. Webhook destinations receive a
JSON `POST`; chat tools can display its `text` field:

```json
{
  "event": "scenario.finished",
  "text": "Scenario Nightly sales (nightly-sales): failed\nTrigger: schedule\n…",
  "scenario": {"slug": "nightly-sales", "name": "Nightly sales", "project": "project_example"},
  "run": {
    "id": "scn_example",
    "status": "failed",
    "trigger": {"source": "schedule", "cron": "30 2 * * 1-5", "timezone": "Europe/Paris", "occurrence": "2026-11-17T01:30:00+00:00"},
    "started": "2026-11-17T01:30:04+00:00",
    "finished": "2026-11-17T01:31:10+00:00",
    "parameters": {},
    "error": null
  },
  "steps": [
    {"job": "load-orders", "name": "Load orders", "status": "success", "run": "run_example", "error": null},
    {"job": "publish-report", "name": "Publish report", "status": "failed", "run": "run_other", "error": "…"}
  ]
}
```
