import { Play, Square } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api, errorDetail, send, withQuery } from "./api";
import { RunDetails } from "./HistoryPanel";
import { useT } from "./i18n";
import { jobCron, jobInvocation } from "./jobs";
import { Job, active, version } from "./jobTypes";
import { ConfirmModal, Modal } from "./modals";
import { worktreeUrl } from "./navigation";
import { displayNodeName, type NodeNames } from "./nodeNames";
import RunProgress from "./RunProgress";
import { useWorkspace } from "./shell";
import type { Environment, Project, Run } from "./types";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { useRunHistory } from "./useRunHistory";

export function JobDetails({
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
  const runs = useRunHistory(
    withQuery(`/jobs/${job.slug}/runs`, { limit: 20 }),
    2000,
  );
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
  const activeRun = active(job.last_run) ? job.last_run!.id : null;
  // The open run's details already poll the active run.
  const running = useApiResource<Run>(
    activeRun && activeRun !== runId ? `/runs/${activeRun}` : null,
    { interval: 2000 },
  );
  const progress =
    activeRun && activeRun === runId ? detail.data : running.data;
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
      {busy && progress && <RunProgress run={progress} />}
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
      {runs.data?.length === 0 && <p className="muted">{t("noHistory")}</p>}
      {runs.data?.map((run) => (
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
      {runs.hasMore && (
        <button
          className="button secondary"
          disabled={runs.loadingMore}
          onClick={() => void runs.loadMore()}
        >
          {t("loadMore")}
        </button>
      )}
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
      {runId && (
        <Modal title={t("goToRun")} onClose={() => setRunId(null)} wide>
          <div className="modal-content">
            {selected ? (
              <>
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
                          void action.run(() =>
                            launch(false, job.revision, true),
                          );
                        }
                      : undefined
                  }
                />
              </>
            ) : detail.error ? (
              <p className="notice error" role="alert">
                {detail.error}
              </p>
            ) : (
              <p>{t("loading")}</p>
            )}
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
