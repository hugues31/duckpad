# Job automation: remaining proposals

Single-instance Jobs are implemented: API tokens, service accounts, Operator
access, annotated tags, pinned versions, reviewed promotion, read-only results,
API v1 and `duckpad run`. Scenarios are implemented too: ordered Job steps with
conditions, typed launch values, cron schedules in a time zone, an authenticated
webhook trigger with duplicate detection, and email or webhook notifications.
Use [Jobs and scenarios](../JOBS.md), [automation](../AUTOMATION.md) and
[Git](../GIT.md) for those features.

Schedules and webhooks launch through the same admission as manual runs. They
record their trigger identity and occurrence or delivery identifier, read fresh
configuration, carry no SQL, connection settings or credentials, and are refused
while the scenario or one of its Jobs runs, never queued, retried or replayed;
refusals and missed occurrences are recorded.

## Proposed deployment between instances

### Two instances: design and execution

Proposed: run separate design and execution instances, exchanging reviewed versions through Git. Deployed projects, project deploy keys and tag transport are not implemented.

```mermaid
sequenceDiagram
    participant A as Duckpad A (design)
    participant G as Git repository
    participant B as Duckpad B (execution)
    participant O as Airflow / Control-M
    A->>A: reviewed merge into main, acceptance Job run
    A->>A: tag sales/2026.10.31 on the tested commit
    A->>G: publish main and the tag
    B->>G: fetch with the project's read-only deploy key
    B->>B: production admin compares and promotes the tag
    O->>B: POST /api/v1/jobs/sales-daily-prod/runs (Operator token)
    B-->>O: run identifier, status, log
```

1. **On A (design)**: development, acceptance and tagging as on a single instance, then publication of `main` and the tag.
2. **On B (execution)**: a project admin creates the project once **from the repository URL**, as a **deployed project**. Nobody can edit a deployed project: saves, branches and merges are refused, and the Editor role is not offered. B fetches with a read-only deploy key that belongs to the project. The production team are Operators, with a production admin. Connections are recreated on B with the same identifiers, since projects store only references to them, and only their `prod` settings are filled in: production secrets exist only on B.
3. The production admin creates the Job `sales-daily-prod` on the tag `sales/2026.10.31` in `prod`.
4. Orchestrators call B's API with a service account token.
5. **Next version**: a new tag is created and published on A. B lists it after the next fetch; the production admin compares and promotes it. Rolling back means promoting the previous tag.

**What travels with a tag**: the flow, SQL, templates, components, documentation, the list of required extensions and `variables.json` with every environment's values, so changed `prod` values appear in the comparison before promotion.

**What does not travel**: connections and their secrets, environments, members, Jobs, extension binaries (install them on B, or import them offline) and uploaded files. Uploads live in instance storage outside Git, so production sources must be connections rather than uploaded files.

**Why not project export and import.** An archive contains only the current files of one worktree, without history or tags, and importing always creates a new project with a single commit. Every delivery would create another project on B, with its Jobs, members, connection grants and run history to recreate; the commit running in production would have no relation to the tagged commit; and the imported history is unrelated to A's, so connecting it to the origin later is refused. Export and import remain useful for one-off copies.

Deploy keys are per project and read-only on the Git host; fetching with them needs no personal key or consent. A fetched tag never replaces a same-named local tag: Duckpad reports the difference. Signed version bundles, for an execution instance without Git access, can come later if needed.

Two instances add machine isolation (a large preview on A cannot slow down or block production), production secrets absent from A, network segmentation and strict separation of roles. A single instance remains a supported setup.

## Delivery plan

The following work remains proposed, not available:

1. **Two instances.** Projects created from a Git URL, the deployed project mode, per-project read-only deploy keys, publishing and fetching tags, new versions listed for promotion.
2. **Automation follow-ups.** Launch values for direct Job launches through API v1 and `duckpad run`; signed outgoing notification webhooks and delivery retries; an in-app notification inbox; a History filter by trigger.
3. **Ready-made integrations.** An Airflow provider in a separate repository (operator, hook, sensor, deferrable mode, OpenLineage events) and a Control-M Application Integrator template.
