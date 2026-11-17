import { CalendarClock, Plus, Workflow } from "lucide-react";
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
import { ScenarioDetails } from "../ScenarioDetails";
import { ScenarioForm } from "../ScenarioForm";
import {
  activeScenario,
  triggerKeys,
  zonedTime,
  type Destination,
  type Scenario,
} from "../scenarioTypes";
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
  const scenarios = useApiResource<Scenario[]>(
    `/projects/${project.id}/scenarios`,
    {
      interval: 2000,
      nextInterval: (values) =>
        values.some((item) => item.active_run || activeScenario(item.last_run))
          ? 2000
          : 10000,
    },
  );
  const destinations = useApiResource<Destination[]>(
    "/notification-destinations",
  );
  const [chosenScenario, setChosenScenario] = useState<string | null>(null);
  const [editingScenario, setEditingScenario] = useState<
    Scenario | "new" | null
  >(null);
  const [deletingScenario, setDeletingScenario] = useState<Scenario | null>(
    null,
  );
  const scenario = scenarios.data?.find((item) => item.slug === chosenScenario);
  // A new Job opens with its API and scheduler examples unfolded.
  const [created, setCreated] = useState<string | null>(null);
  const current = jobs.data?.find((job) => job.slug === selected);
  const changed = async () => {
    jobs.reload();
    scenarios.reload();
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
          <div className="row gap">
            <button
              className="button secondary"
              onClick={() => setEditing("new")}
            >
              <Plus size={16} />
              {t("newJob")}
            </button>
            <button
              className="button primary"
              onClick={() => setEditingScenario("new")}
            >
              <Plus size={16} />
              {t("newScenario")}
            </button>
          </div>
        )}
      </div>
      <h2 className="jobs-section">{t("scenarios")}</h2>
      <p className="muted">{t("scenariosHint")}</p>
      {scenarios.error && (
        <p className="notice error" role="alert">
          {scenarios.error}
        </p>
      )}
      {scenarios.data?.length === 0 && (
        <div className="empty-state compact">
          <Workflow size={24} aria-hidden="true" />
          <p>
            {t(project.role === "admin" ? "noScenariosAdmin" : "noScenarios")}
          </p>
        </div>
      )}
      {!!scenarios.data?.length && (
        <div className="administration-table">
          <table>
            <thead>
              <tr>
                {(
                  [
                    "scenario",
                    "scenarioSteps",
                    "scenarioTriggers",
                    "nextOccurrence",
                    "jobLastRun",
                    "jobStatus",
                  ] as const
                ).map((key) => (
                  <th key={key}>{t(key)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scenarios.data.map((item) => {
                const next = item.enabled
                  ? item.schedules
                      .filter((schedule) => schedule.next)
                      .sort((a, b) => a.next!.localeCompare(b.next!))[0]
                  : undefined;
                return (
                  <tr key={item.slug}>
                    <td>
                      <button
                        className="text-button"
                        aria-pressed={chosenScenario === item.slug}
                        onClick={() => setChosenScenario(item.slug)}
                      >
                        {item.name}
                      </button>
                      <small className="muted"> {item.slug}</small>
                      {!item.enabled && (
                        <span className="badge neutral">
                          {t("scenarioDisabled")}
                        </span>
                      )}
                    </td>
                    <td>
                      {item.steps
                        .map((step) => step.name ?? step.job)
                        .join(" → ")}
                    </td>
                    <td>
                      {[
                        ...(item.schedules.length
                          ? [
                              `${t(triggerKeys.schedule)} (${item.schedules.length})`,
                            ]
                          : []),
                        ...(item.webhook ? [t(triggerKeys.webhook)] : []),
                      ].join(" · ") || t(triggerKeys.manual)}
                    </td>
                    <td>{next ? zonedTime(next.next!, next.timezone) : "—"}</td>
                    <td>
                      {item.last_run
                        ? new Date(item.last_run.started).toLocaleString()
                        : "—"}
                    </td>
                    <td>
                      {item.last_run ? (
                        <span className={`badge ${item.last_run.status}`}>
                          {t(
                            item.last_run.status === "rejected"
                              ? "triggerRejected"
                              : item.last_run.status === "missed"
                                ? "occurrenceMissed"
                                : item.last_run.status,
                          )}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {scenario && (
        <ScenarioDetails
          key={scenario.slug}
          scenario={scenario}
          project={project}
          destinations={destinations.data || []}
          onChanged={changed}
          onEdit={() => setEditingScenario(scenario)}
          onDelete={() => setDeletingScenario(scenario)}
        />
      )}
      <h2 className="jobs-section">{t("jobs")}</h2>
      <p className="muted">{t("jobsSectionHint")}</p>
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
      {editingScenario && (
        <ScenarioForm
          project={project}
          scenario={editingScenario === "new" ? null : editingScenario}
          jobs={jobs.data || []}
          destinations={destinations.data || []}
          onClose={() => setEditingScenario(null)}
          onSaved={async (saved) => {
            setChosenScenario(saved.slug);
            setEditingScenario(null);
            await changed();
          }}
        />
      )}
      {deletingScenario && (
        <ConfirmModal
          title={t("deleteScenario")}
          confirmLabel={t("deleteScenario")}
          onClose={() => setDeletingScenario(null)}
          onConfirm={async () => {
            await api(`/scenarios/${deletingScenario.slug}`, {
              method: "DELETE",
            });
            setChosenScenario(null);
            await changed();
          }}
        >
          <p>
            {t("deleteScenarioHint")} <strong>{deletingScenario.name}</strong>
          </p>
        </ConfirmModal>
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
