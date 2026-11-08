import { CalendarClock, Plus } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { api } from "../api";
import { useT } from "../i18n";
import { Job, active, version } from "../jobTypes";
import { ConfirmModal } from "../modals";
import { useShell, useWorkspace } from "../shell";
import type { Project } from "../types";
import { useApiResource } from "../useApiResource";
import { JobDetails } from "../JobDetails";
import { JobForm, VersionModal } from "../JobForms";
import { PageLoading, RouteError } from "./PageStates";

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
