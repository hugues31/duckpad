import { useState } from "react";
import { Link, useParams } from "react-router";
import { Play, Plus, Square } from "lucide-react";
import { api, errorDetail, send, withQuery } from "../api";
import ComparisonView from "../ComparisonView";
import type { Branch, Comparison, GitTag } from "../gitTypes";
import { RunDetails } from "../HistoryPanel";
import { useT } from "../i18n";
import { ConfirmModal, Modal } from "../modals";
import { worktreeUrl } from "../navigation";
import Select from "../Select";
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
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [changing, setChanging] = useState<{ job: Job; tag?: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<Job | null>(null);
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
        <Link className="button secondary" to={worktreeUrl(project.main)}>
          {t("flow")}
        </Link>
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
      {jobs.data?.length === 0 && <p className="empty-state">{t("noJobs")}</p>}
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
  onChanged,
  onEdit,
  onVersion,
  onDelete,
}: {
  job: Job;
  project: Project;
  onChanged: () => Promise<void>;
  onEdit: () => void;
  onVersion: (tag?: string) => void;
  onDelete: () => void;
}) {
  const t = useT();
  const workspace = useWorkspace();
  const action = useAsyncAction();
  const runs = useApiResource<Run[]>(`/jobs/${job.slug}/runs`, {
    interval: 2000,
  });
  const [runId, setRunId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<
    (Environment & { job_revision: string }) | null
  >(null);
  const selected = runs.data?.find((run) => run.id === runId);
  const busy = active(job.last_run);
  const canRun = project.role !== "reader";
  const launch = async (confirmed = false, revision = job.revision) => {
    try {
      await api(
        `/jobs/${job.slug}/runs`,
        send({ entry_point: "ui", confirmed, revision }),
      );
      runs.reload();
      await onChanged();
    } catch (error) {
      const settings = errorDetail(error).confirmation_required as
        Environment | undefined;
      if (settings) setConfirmation({ ...settings, job_revision: revision });
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
        {t("jobScope")}: {job.scope || t("jobWholeProject")} · {t("jobVersion")}
        : {version(job.target)} ·{" "}
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
      <h3>{t("jobRecentRuns")}</h3>
      {runs.error && <p className="notice error">{runs.error}</p>}
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
      {selected && (
        <Modal title={t("goToRun")} onClose={() => setRunId(null)} wide>
          <div className="modal-content">
            <p>
              <span className={`badge ${selected.status}`}>
                {t(selected.status)}
              </span>{" "}
              · <code>{selected.id}</code>
            </p>
            <RunDetails run={selected} onClose={() => setRunId(null)} />
          </div>
        </Modal>
      )}
      {confirmation && (
        <ConfirmModal
          title={t("runJob")}
          confirmLabel={t("runJob")}
          onClose={() => setConfirmation(null)}
          onConfirm={() => launch(true, confirmation.job_revision)}
        >
          <p>
            {t("jobConfirmEnvironment")} <strong>{confirmation.label}</strong>
          </p>
          <p>
            {job.name} · {version(job.target)}
          </p>
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
  const [kind, setKind] = useState<"tag" | "branch">("tag");
  const tags = useApiResource<GitTag[]>(`/worktrees/${project.main}/git/tags`);
  const branches = useApiResource<Branch[]>(
    `/worktrees/${project.main}/git/branches`,
  );
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
            scope: data.get("scope") || null,
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
                      target: { kind, ref: data.get("ref") },
                    },
                job ? "PATCH" : "POST",
              ),
            );
            await onSaved(saved);
          });
        }}
      >
        <div className="modal-content">
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
                autoFocus
              />
              <small className="muted" id="job-slug-help">
                {t("jobSlugHint")}
              </small>
            </label>
          )}
          <label className="field">
            <span>{t("name")}</span>
            <input
              name="name"
              required
              maxLength={120}
              defaultValue={job?.name}
            />
          </label>
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
          <label className="field">
            <span>{t("jobScope")}</span>
            <input
              name="scope"
              aria-label={t("jobScope")}
              aria-describedby="job-scope-help"
              defaultValue={job?.scope || ""}
              placeholder={t("jobWholeProject")}
            />
            <small className="muted" id="job-scope-help">
              {t("jobScopeHint")}
            </small>
          </label>
          {!job && (
            <>
              <label className="field">
                <span>{t("jobTarget")}</span>
                <Select
                  aria-label={t("jobTarget")}
                  value={kind}
                  onChange={(e) => setKind(e.target.value as "tag" | "branch")}
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
                  key={kind}
                  required
                  defaultValue=""
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
          {(action.error || tags.error || branches.error) && (
            <p className="notice error" role="alert">
              {action.error || tags.error || branches.error}
            </p>
          )}
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="button primary" disabled={action.pending}>
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
