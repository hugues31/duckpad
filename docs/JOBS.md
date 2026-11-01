# Jobs

Run a reviewed project version in a chosen environment, independently of your working branch.

## Run a Job

Open **Jobs** from the project toolbar to run reviewed versions separately from
working branches. Readers can inspect Jobs, their logs, results and version history.
Operators and higher roles can **Run Job**, cancel an active run, or run it again.
A protected environment asks for confirmation before launch. Each Job accepts one
run at a time: a busy launch is refused with the active run ID, without queuing or
retrying it. Different Jobs can run in parallel.

## Create a Job

Project admins choose **New Job**, then enter a permanent instance-wide slug
(lowercase letters, digits and hyphens), name, description, environment and scope.
Leave scope empty for the whole project, or supply a node ID such as `report` or
`component::node` to run its launch scope, including upstream dependencies.
Choose a tag to pin its current commit, or a branch for acceptance runs that should
resolve the branch head at each launch. Uncommitted edits are never a Job target.
Run-time variable overrides are not available yet; each run uses the versioned
`variables.json` values for the selected environment.

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
