import { useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Clock,
  GitBranch,
  GitCommitHorizontal,
} from "lucide-react";
import { api, withQuery } from "./api";
import { useT } from "./i18n";
import { Modal } from "./modals";
import type { Json } from "./types";

export default function HistoryPanel({
  readOnly = false,
  worktree,
  onDiff,
  onRevision,
  onCompare,
}: {
  readOnly?: boolean;
  worktree: string;
  onDiff: (commit: string) => void;
  onRevision: (commit: string) => void;
  onCompare: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<"runs" | "git">("runs");
  const [runs, setRuns] = useState<Json[]>([]);
  const [commits, setCommits] = useState<Json[]>([]);
  const [selected, setSelected] = useState<Json | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    Promise.all([
      api(withQuery("/runs", { worktree })),
      api(`/worktrees/${worktree}/history`),
    ])
      .then(([r, c]) => {
        if (!live) return;
        setRuns(r);
        setCommits(c);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [worktree]);
  return (
    <section className="full-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("history")}</span>
          <h1>{tab === "runs" ? t("runHistory") : t("gitHistory")}</h1>
        </div>
        <button className="button secondary" onClick={onCompare}>
          {t("compareVersions")}
        </button>
        <div className="segmented">
          <button
            className={tab === "runs" ? "active" : ""}
            aria-pressed={tab === "runs"}
            onClick={() => setTab("runs")}
          >
            {t("runHistory")}
          </button>
          <button
            className={tab === "git" ? "active" : ""}
            aria-pressed={tab === "git"}
            onClick={() => setTab("git")}
          >
            {t("gitHistory")}
          </button>
        </div>
      </div>
      {error && <p className="notice error">{error}</p>}
      {tab === "runs" ? (
        <>
          <p className="muted">{t("metadataOnly")}</p>
          {!runs.length && (
            <div className="empty-state">
              <Clock />
              <h3>{t("noHistory")}</h3>
            </div>
          )}
          {runs.map((run) => (
            <button
              className="history-row"
              key={run.id}
              onClick={() => setSelected(run)}
            >
              <span className={`history-icon ${run.status}`}>
                {run.status === "success" ? (
                  <Check size={17} />
                ) : run.status === "failed" ||
                  run.status === "partial_failure" ? (
                  <AlertCircle size={17} />
                ) : (
                  <Clock size={17} />
                )}
              </span>
              <span className="grow">
                <strong>
                  {run.scope === "project" ? t("run") : run.scope}
                </strong>
                <small>
                  {new Date(run.started).toLocaleString()} · {run.environment} ·{" "}
                  {run.branch}
                </small>
              </span>
              <span className={`badge ${run.status}`}>{t(run.status)}</span>
              <span>{run.duration?.toFixed(2)} s</span>
              <ArrowRight size={15} />
            </button>
          ))}
        </>
      ) : (
        commits.map((commit) => (
          <div className="history-row" key={commit.commit}>
            <GitCommitHorizontal size={21} />
            <span className="grow">
              <strong>{commit.message}</strong>
              <small>
                {commit.author} · {new Date(commit.date).toLocaleString()} ·{" "}
                {commit.commit.slice(0, 8)}
              </small>
            </span>
            <button
              className="button secondary small"
              onClick={() => onDiff(commit.commit)}
            >
              {t("diff")}
            </button>
            <button
              className="icon"
              title={t("restoreRevision")}
              disabled={readOnly}
              onClick={() => onRevision(commit.commit)}
            >
              <GitBranch size={17} />
            </button>
          </div>
        ))
      )}
      {selected && (
        <Modal title={t("goToRun")} onClose={() => setSelected(null)} wide>
          <div className="modal-content">
            <div className="row gap">
              <span className={`badge ${selected.status}`}>
                {t(selected.status)}
              </span>
              <code>{selected.id}</code>
              <span className="muted">
                {selected.environment} · {selected.commit.slice(0, 8)}
              </span>
            </div>
            {selected.error && <p className="notice error">{selected.error}</p>}
            <details className="run-step">
              <summary>{t("executionConfiguration")}</summary>
              <pre className="expression">
                {JSON.stringify(
                  {
                    commit: selected.commit,
                    environment: selected.environment,
                    scope: selected.scope,
                    trigger: selected.trigger,
                    entry_point: selected.entry_point,
                    started: selected.started,
                    finished: selected.finished,
                    connections: selected.connections,
                    definitions: selected.definitions,
                    components: selected.components,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {Object.entries(selected.nodes).map(([key, state]) => (
              <details className="run-step" key={key}>
                <summary>
                  <span className={`badge ${(state as Json).status}`}>
                    {t((state as Json).status)}
                  </span>
                  <strong>{(state as Json).label}</strong>
                  <span className="muted">
                    {(state as Json).duration?.toFixed(3)} s
                  </span>
                </summary>
                {(state as Json).error && (
                  <p className="notice error">{(state as Json).error}</p>
                )}
                {(state as Json).external_outcome && (
                  <p className="notice">
                    {t("externalOutcome")}:{" "}
                    {t((state as Json).external_outcome)}
                  </p>
                )}
                <pre className="expression">
                  {JSON.stringify(state, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}
