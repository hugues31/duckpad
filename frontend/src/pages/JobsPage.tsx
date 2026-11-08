import { useState } from "react";
import { Link, useParams } from "react-router";
import { CalendarClock, Play, Plus, Square } from "lucide-react";
import { api, errorDetail, send, withQuery } from "../api";
import ComparisonView from "../ComparisonView";
import type { Branch, Comparison, GitTag } from "../gitTypes";
import { useRunHistory } from "../useRunHistory";
import { RunDetails } from "../HistoryPanel";
import RunProgress from "../RunProgress";
import { useT } from "../i18n";
import { ConfirmModal, Modal } from "../modals";
import { worktreeUrl } from "../navigation";
import Select from "../Select";
import { SearchField } from "../Search";
import { displayNodeName, type NodeNames } from "../nodeNames";
import { jobSlug, jobInvocation, jobCron } from "../jobs";
import { useShell, useWorkspace } from "../shell";
import type { Environment, Project, Run } from "../types";
import { useApiResource } from "../useApiResource";
import { useAsyncAction } from "../useAsyncAction";
import { PageLoading, RouteError } from "./PageStates";

interface Target {
  kind: "tag" | "branch";
  tag?: string;
  branch?: string;
  commit?: string;
}
interface Job {
  slug: string;
  name: string;
  description: string;
  worktree: string;
  environment: string;
  scope: string | null;
  target: Target;
  revision: string;
  warning: "tag_moved" | "target_unavailable" | null;
  resolved_commit: string | null;
  last_run: Run | null;
  versions: {
    at: string;
    actor: { username: string };
    previous: Target | null;
    target: Target;
    previous_commit: string | null;
    commit: string;
  }[];
}
interface Review {
  revision: string;
  previous_commit: string;
  commit: string;
  comparison: Comparison;
}
const active = (run: Run | null) =>
  !!run && ["preparing", "running", "canceling"].includes(run.status);
const version = (target: Target) => target.tag || target.branch;

export default function JobsPage() {
  const { projectId } = useParams();
  const workspace = useWorkspace();
  const project = workspace.projects.find((item) => item.id === projectId);
  if (!project) return <RouteError />;
  return <ProjectJobs key={project.id} project={project} />;
}

function ProjectJobs({ project }: { project: Project }) {
  const t = useT();
  const { refreshWorkspace } = useShell();
  const jobs = useApiResource<Job[]>(`/projects/${project.id}/jobs`, {
    interval: 2000,
    nextInterval: (values) =>
      values.some((job) => active(job.last_run)) ? 2000 : 10000,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [changing, setChanging] = useState<{ job: Job; tag?: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<Job | null>(null);
  // A new Job opens with its API and scheduler examples unfolded.
  const [created, setCreated] = useState<string | null>(null);
  const current = jobs.data?.find((job) => job.slug === selected);
  const changed = async () => {
    jobs.reload();
    await refreshWorkspace();
  };
  return (
    <section className="full-panel jobs-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{project.name}</span>
          <h1>{t("jobs")}</h1>
          <p className="muted">{t("jobsHint")}</p>
        </div>
        {project.role === "admin" && (
          <button className="button primary" onClick={() => setEditing("new")}>
            <Plus size={16} />
            {t("newJob")}
          </button>
        )}
      </div>
      {jobs.error && (
        <p className="notice error" role="alert">
          {jobs.error}
        </p>
      )}
      {!jobs.data && !jobs.error && <PageLoading />}
      {jobs.data?.length === 0 &&
        (project.role === "admin" ? (
          <div className="empty-state">
            <CalendarClock size={28} aria-hidden="true" />
            <p>{t("noJobsAdmin")}</p>
            <button
              className="button primary"
              onClick={() => setEditing("new")}
            >
              <Plus size={16} />
              {t("newJob")}
            </button>
          </div>
        ) : (
          <p className="empty-state">{t("noJobs")}</p>
        ))}
      <div className="administration-table">
        <table>
          <thead>
            <tr>
              {(
                [
                  "job",
                  "jobVersion",
                  "environment",
                  "jobLastRun",
                  "jobStatus",
                ] as const
              ).map((key) => (
                <th key={key}>{t(key)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {jobs.data?.map((job) => (
              <tr key={job.slug}>
                <td>
                  <button
                    className="text-button"
                    aria-pressed={selected === job.slug}
                    onClick={() => setSelected(job.slug)}
                  >
                    {job.name}
                  </button>
                  <small className="muted"> {job.slug}</small>
                </td>
                <td>
                  {version(job.target)}{" "}
                  <code>
                    {(job.target.commit || job.resolved_commit)?.slice(0, 8)}
                  </code>
                  {job.warning && (
                    <span className="badge warning">{t("jobWarning")}</span>
                  )}
                </td>
                <td>{job.environment}</td>
                <td>
                  {job.last_run
                    ? new Date(job.last_run.started).toLocaleString()
                    : "—"}
                </td>
                <td>
                  {job.last_run ? (
                    <span className={`badge ${job.last_run.status}`}>
                      {t(job.last_run.status)}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {current && (
        <JobDetails
          key={current.slug}
          job={current}
          project={project}
          created={created === current.slug}
          onChanged={changed}
          onEdit={() => setEditing(current)}
          onVersion={(tag) => setChanging({ job: current, tag })}
          onDelete={() => setDeleting(current)}
        />
      )}
      {editing && (
        <JobForm
          project={project}
          job={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (job) => {
            if (editing === "new") setCreated(job.slug);
            setSelected(job.slug);
            setEditing(null);
            await changed();
          }}
        />
      )}
      {changing && (
        <VersionModal
          job={changing.job}
          project={project}
          initialTag={changing.tag}
          onClose={() => setChanging(null)}
          onSaved={changed}
        />
      )}
      {deleting && (
        <ConfirmModal
          title={t("deleteJob")}
          confirmLabel={t("deleteJob")}
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/jobs/${deleting.slug}`, { method: "DELETE" });
            setSelected(null);
            await changed();
          }}
        >
          <p>
            {t("deleteJobHint")} <strong>{deleting.name}</strong>
          </p>
        </ConfirmModal>
      )}
    </section>
  );
}

function JobDetails({
  job,
  project,
  created,
  onChanged,
  onEdit,
  onVersion,
  onDelete,
}: {
  job: Job;
  project: Project;
  created: boolean;
  onChanged: () => Promise<void>;
  onEdit: () => void;
  onVersion: (tag?: string) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const workspace = useWorkspace();
  const action = useAsyncAction();
  const runs = useRunHistory(`/jobs/${job.slug}/runs`, 2000);
  const names = useApiResource<NodeNames>(
    job.scope ? `/jobs/${job.slug}/nodes` : null,
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<
    (Environment & { job_revision: string; failedPartitions?: boolean }) | null
  >(null);
  const detail = useApiResource<Run>(runId ? `/runs/${runId}` : null, {
    interval: 2000,
    nextInterval: (value) => (active(value) ? 2000 : false),
  });
  const selected = detail.data;
  const running = useApiResource<Run>(
    active(job.last_run) ? `/runs/${job.last_run!.id}` : null,
    { interval: 2000 },
  );
  const busy = active(job.last_run);
  const canRun = project.role !== "reader";
  const launch = async (
    confirmed = false,
    revision = job.revision,
    failedPartitions = false,
  ) => {
    try {
      await api(
        `/jobs/${job.slug}/runs`,
        send({
          entry_point: "ui",
          confirmed,
          revision,
          ...(failedPartitions ? { partitions: { mode: "failed" } } : {}),
        }),
      );
      runs.reload();
      await onChanged();
    } catch (error) {
      const settings = errorDetail(error).confirmation_required as
        Environment | undefined;
      if (settings)
        setConfirmation({
          ...settings,
          job_revision: revision,
          failedPartitions,
        });
      else throw error;
    }
  };
  return (
    <section className="job-details settings-card">
      <div className="page-heading">
        <div>
          <h2>{job.name}</h2>
          <p>{job.description}</p>
        </div>
        <div className="row gap">
          <Link
            className="button secondary"
            to={worktreeUrl(
              job.worktree,
              "flow",
              job.last_run?.environment || job.environment,
            )}
          >
            {t("openResults")}
          </Link>
          {canRun &&
            (busy ? (
              <button
                className="button stop"
                disabled={
                  action.pending || job.last_run?.status === "canceling"
                }
                onClick={() =>
                  void action.run(async () => {
                    await api(`/runs/${job.last_run!.id}/cancel`, send({}));
                    await onChanged();
                  })
                }
              >
                <Square size={14} />
                {t("stop")}
              </button>
            ) : (
              <button
                className="button primary"
                disabled={action.pending}
                onClick={() => {
                  const settings = workspace.catalog.environment_details.find(
                    (env) => env.id === job.environment,
                  );
                  if (settings?.confirm_before_run)
                    setConfirmation({
                      ...settings,
                      job_revision: job.revision,
                    });
                  else void action.run(() => launch());
                }}
              >
                <Play size={14} />
                {t("runJob")}
              </button>
            ))}
        </div>
      </div>
      {busy && running.data && <RunProgress run={running.data} />}
      {action.error && (
        <p className="notice error" role="alert">
          {action.error}
        </p>
      )}
      {job.warning && (
        <p className="notice warning">
          {t(
            job.warning === "tag_moved"
              ? "jobTagMoved"
              : "jobTargetUnavailable",
          )}
        </p>
      )}
      <p className="muted">
        {t("jobScope")}:{" "}
        <span title={job.scope || undefined}>
          {job.scope
            ? displayNodeName(names.data?.[job.scope], job.scope, t)
            : t("jobWholeProject")}
        </span>{" "}
        · {t("jobVersion")}: {version(job.target)} ·{" "}
        <code>{job.target.commit || job.resolved_commit}</code>
      </p>
      {project.role === "admin" && (
        <div className="row gap">
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => onVersion()}
          >
            {t("changeJobVersion")}
          </button>
          <button className="button secondary" disabled={busy} onClick={onEdit}>
            {t("edit")}
          </button>
          <button
            className="button secondary danger"
            disabled={busy}
            onClick={onDelete}
          >
            {t("deleteJob")}
          </button>
        </div>
      )}
      <details open={created}>
        <summary>{t("jobAutomation")}</summary>
        <p>{t("jobAutomationHint")}</p>
        <pre className="expression">
          {jobInvocation(job.slug, window.location.origin)}
        </pre>
        <pre className="expression">
          {jobCron(job.slug, window.location.origin)}
        </pre>
      </details>
      <h3>{t("jobRecentRuns")}</h3>
      {runs.error && <p className="notice error">{runs.error}</p>}
      {detail.error && (
        <p className="notice error" role="alert">
          {detail.error}
        </p>
      )}
      {runs.data?.length === 0 && <p className="muted">{t("noHistory")}</p>}
      {runs.data?.slice(0, 20).map((run) => (
        <button
          className="history-row"
          key={run.id}
          onClick={() => setRunId(run.id)}
        >
          <span className={`badge ${run.status}`}>{t(run.status)}</span>
          <span className="grow">
            {new Date(run.started).toLocaleString()} · {run.requester?.username}
          </span>
          <span>{run.tag || run.job?.branch}</span>
          <code>{run.commit.slice(0, 8)}</code>
        </button>
      ))}
      <details>
        <summary>{t("jobVersionHistory")}</summary>
        {[...job.versions].reverse().map((entry, index) => (
          <div className="history-row" key={`${entry.at}-${index}`}>
            <span className="grow">
              <strong>
                {version(entry.previous || entry.target)} →{" "}
                {version(entry.target)}
              </strong>
              <small>
                {new Date(entry.at).toLocaleString()} · {entry.actor.username} ·{" "}
                {entry.previous_commit?.slice(0, 8) || "—"} →{" "}
                {entry.commit.slice(0, 8)}
              </small>
            </span>
            {project.role === "admin" && entry.target.tag && (
              <button
                className="button secondary small"
                disabled={busy}
                onClick={() => onVersion(entry.target.tag)}
              >
                {t("jobRestoreVersion")}
              </button>
            )}
          </div>
        ))}
      </details>
      {runs.hasMore && (
        <button
          className="button secondary"
          disabled={runs.loadingMore}
          onClick={() => void runs.loadMore()}
        >
          {t("loadMore")}
        </button>
      )}
      {selected && (
        <Modal title={t("goToRun")} onClose={() => setRunId(null)} wide>
          <div className="modal-content">
            <p>
              <span className={`badge ${selected.status}`}>
                {t(selected.status)}
              </span>{" "}
              · <code>{selected.id}</code>
            </p>
            <RunDetails
              run={selected}
              onClose={() => setRunId(null)}
              onPartitionRetry={
                canRun && !busy && !action.pending
                  ? () => {
                      setRunId(null);
                      void action.run(() => launch(false, job.revision, true));
                    }
                  : undefined
              }
            />
          </div>
        </Modal>
      )}
      {confirmation && (
        <ConfirmModal
          title={t("runJob")}
          confirmLabel={t("runJob")}
          onClose={() => setConfirmation(null)}
          onConfirm={() =>
            launch(
              true,
              confirmation.job_revision,
              confirmation.failedPartitions,
            )
          }
        >
          <p>
            {t("jobConfirmEnvironment")} <strong>{confirmation.label}</strong>
          </p>
          <p>
            {job.name} · {version(job.target)}
          </p>
          {confirmation.failedPartitions && (
            <p>
              {t("partitionRunFailed")} · {t("partitionFreshLaunch")} ·{" "}
              {t("partitionExportNotice")}
            </p>
          )}
        </ConfirmModal>
      )}
    </section>
  );
}

function JobForm({
  project,
  job,
  onClose,
  onSaved,
}: {
  project: Project;
  job: Job | null;
  onClose: () => void;
  onSaved: (job: Job) => Promise<void>;
}) {
  const t = useT();
  const workspace = useWorkspace();
  const action = useAsyncAction();
  const [targetKind, setKind] = useState<"tag" | "branch" | null>(null);
  const [chosenRef, setRef] = useState<string | null>(null);
  const [name, setName] = useState(job?.name || "");
  const [slug, setSlug] = useState<string | null>(null);
  const [scope, setScope] = useState(job?.scope || "");
  const [scopeQuery, setScopeQuery] = useState("");
  const tags = useApiResource<GitTag[]>(`/worktrees/${project.main}/git/tags`);
  const branches = useApiResource<Branch[]>(
    `/worktrees/${project.main}/git/branches`,
  );
  const kind = targetKind ?? (tags.data?.length ? "tag" : "branch");
  // Without tags, the Job targets the main branch until another is chosen.
  const ref =
    chosenRef ??
    (tags.data && kind === "branch"
      ? workspace.worktrees.find((item) => item.id === project.main)?.branch ||
        ""
      : "");
  const nodes = useApiResource<NodeNames>(
    job
      ? `/jobs/${job.slug}/nodes`
      : ref
        ? withQuery(`/projects/${project.id}/job-nodes`, { kind, ref })
        : null,
  );
  const scopeOptions = [
    { key: "", label: t("jobWholeProject"), detail: "" },
    ...Object.entries(nodes.data || {}).map(([key, parts]) => ({
      key,
      label: displayNodeName(parts, t("node"), t),
      detail: "",
    })),
  ].filter((item) =>
    item.label.toLocaleLowerCase().includes(scopeQuery.toLocaleLowerCase()),
  );
  const scopeValid = !scope || !!nodes.data?.[scope];
  return (
    <Modal title={t(job ? "editJob" : "newJob")} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const fields = {
            name: data.get("name"),
            description: data.get("description"),
            environment: data.get("environment"),
            scope: scope || null,
          };
          void action.run(async () => {
            const saved = await api<Job>(
              job ? `/jobs/${job.slug}` : `/projects/${project.id}/jobs`,
              send(
                job
                  ? { ...fields, revision: job.revision }
                  : {
                      ...fields,
                      slug: data.get("slug"),
                      target: { kind, ref },
                    },
                job ? "PATCH" : "POST",
              ),
            );
            await onSaved(saved);
          });
        }}
      >
        <div className="modal-content">
          <label className="field">
            <span>{t("name")}</span>
            <input
              name="name"
              required
              maxLength={120}
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          {!job && (
            <label className="field">
              <span>{t("jobSlug")}</span>
              <input
                name="slug"
                aria-label={t("jobSlug")}
                aria-describedby="job-slug-help"
                required
                maxLength={80}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                value={slug ?? jobSlug(name)}
                onChange={(event) => setSlug(event.target.value)}
              />
              <small className="muted" id="job-slug-help">
                {t("jobSlugHint")}
              </small>
            </label>
          )}
          <label className="field">
            <span>{t("jobDescription")}</span>
            <textarea
              name="description"
              maxLength={2000}
              defaultValue={job?.description}
            />
          </label>
          <label className="field">
            <span>{t("environment")}</span>
            <Select
              aria-label={t("environment")}
              name="environment"
              defaultValue={job?.environment || "dev"}
            >
              {workspace.catalog.environment_details.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.label}
                </option>
              ))}
            </Select>
          </label>
          {!job && (
            <>
              <label className="field">
                <span>{t("jobTarget")}</span>
                <Select
                  aria-label={t("jobTarget")}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as "tag" | "branch");
                    setRef(null);
                    setScope("");
                  }}
                >
                  <option value="tag">{t("jobTagTarget")}</option>
                  <option value="branch">{t("jobBranchTarget")}</option>
                </Select>
              </label>
              <label className="field">
                <span>{t("jobVersion")}</span>
                <Select
                  aria-label={t("jobVersion")}
                  name="ref"
                  required
                  value={ref}
                  onChange={(event) => {
                    // Keep the target that lists this version, even if tags
                    // finish loading afterwards.
                    setKind(kind);
                    setRef(event.target.value);
                    setScope("");
                  }}
                >
                  <option value="">{t("jobChooseVersion")}</option>
                  {(kind === "tag" ? tags.data || [] : branches.data || []).map(
                    (item) => (
                      <option key={item.name} value={item.name}>
                        {item.name}
                      </option>
                    ),
                  )}
                </Select>
              </label>
            </>
          )}
          <div className="field job-scope">
            <span>{t("jobScope")}</span>
            <p title={scope}>
              {scope
                ? displayNodeName(nodes.data?.[scope], t("node"), t)
                : t("jobWholeProject")}
            </p>
            <SearchField
              label={t("jobScope")}
              query={scopeQuery}
              onQuery={setScopeQuery}
              options={scopeOptions}
              inline
              pending={nodes.pending}
              onSelect={(index) => {
                setScope(scopeOptions[index].key);
                setScopeQuery("");
              }}
            />
            <small className="muted">{t("jobScopeSelectHint")}</small>
          </div>
          {(action.error || tags.error || branches.error || nodes.error) && (
            <p className="notice error" role="alert">
              {action.error || tags.error || branches.error || nodes.error}
            </p>
          )}
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button
            className="button primary"
            disabled={
              action.pending ||
              nodes.pending ||
              !scopeValid ||
              (!job && (!ref || tags.pending || branches.pending))
            }
          >
            {t(job ? "save" : "create")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function VersionModal({
  job,
  project,
  initialTag = "",
  onClose,
  onSaved,
}: {
  job: Job;
  project: Project;
  initialTag?: string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [tag, setTag] = useState(initialTag);
  const [kind, setKind] = useState<"tag" | "branch">(
    initialTag ? "tag" : job.target.kind,
  );
  const tags = useApiResource<GitTag[]>(`/worktrees/${project.main}/git/tags`);
  const branches = useApiResource<Branch[]>(
    `/worktrees/${project.main}/git/branches`,
  );
  const review = useApiResource<Review>(
    tag ? withQuery(`/jobs/${job.slug}/version`, { kind, ref: tag }) : null,
  );
  const action = useAsyncAction();
  return (
    <Modal title={t("changeJobVersion")} onClose={onClose} wide>
      <div className="modal-content">
        <label className="field">
          <span>{t("jobTarget")}</span>
          <Select
            aria-label={t("jobTarget")}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as "tag" | "branch");
              setTag("");
            }}
          >
            <option value="tag">{t("jobTagTarget")}</option>
            <option value="branch">{t("jobBranchTarget")}</option>
          </Select>
        </label>
        <label className="field">
          <span>{t("jobVersion")}</span>
          <Select
            aria-label={t("jobVersion")}
            value={tag}
            onChange={(event) => setTag(event.target.value)}
          >
            <option value="">{t("jobChooseVersion")}</option>
            {(kind === "tag" ? tags.data : branches.data)?.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </Select>
        </label>
        <h3>{t("compareVersions")}</h3>
        <p className="muted">{t("jobCompareHint")}</p>
        {(review.error || action.error || tags.error || branches.error) && (
          <p className="notice error" role="alert">
            {review.error || action.error || tags.error || branches.error}
          </p>
        )}
        {review.pending && <PageLoading />}
        {review.data && (
          <>
            <p>
              <code>
                {review.data.previous_commit.slice(0, 8)} →{" "}
                {review.data.commit.slice(0, 8)}
              </code>
            </p>
            <ComparisonView
              report={review.data.comparison}
              storageKey={`job-comparison.${job.slug}`}
            />
          </>
        )}
      </div>
      <footer>
        <button className="button secondary" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className="button primary"
          disabled={!review.data || review.pending || action.pending}
          onClick={() =>
            void action.run(async () => {
              const { revision, previous_commit, commit } = review.data!;
              await api(
                `/jobs/${job.slug}/version`,
                send({
                  revision,
                  previous_commit,
                  commit,
                  target: { kind, ref: tag },
                }),
              );
              await onSaved();
              onClose();
            })
          }
        >
          {t("confirmJobVersion")}
        </button>
      </footer>
    </Modal>
  );
}
