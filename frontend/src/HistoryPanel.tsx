import { useState } from "react";
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
import type { GitTag, HistoryPage } from "./gitTypes";
import type { Run } from "./types";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import NewTagModal from "./NewTagModal";
import TagBadges from "./TagBadges";
import { VariableValues } from "./VariableFields";
import ExecutionMessages, {
  WarningBadge,
  warningCount,
} from "./ExecutionMessages";

/** The node parameters using each variable of a run, as "Node · parameter". */
function boundParameters(run: Run) {
  const result: Record<string, string[]> = Object.create(null);
  const add = (name: string, usage: string) => {
    const usages = (result[name] ||= []);
    if (!usages.includes(usage)) usages.push(usage);
  };
  for (const state of Object.values(run.nodes || {})) {
    for (const [parameter, name] of Object.entries(state.variables || {}))
      add(name, `${state.label} · ${parameter}`);
    for (const [parameter, names] of Object.entries(state.references || {}))
      for (const name of names) add(name, `${state.label} · ${parameter}`);
  }
  return result;
}

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
  const [selected, setSelected] = useState<Run | null>(null);
  const [tagCommit, setTagCommit] = useState<string | null>(null);
  const tags = useApiResource<GitTag[]>(`/worktrees/${worktree}/git/tags`);
  const more = useAsyncAction();
  const runHistory = useApiResource<Run[]>(withQuery("/runs", { worktree }));
  const gitHistory = useApiResource<HistoryPage>(
    withQuery(`/worktrees/${worktree}/git/history`, { limit: 100 }),
  );
  const runs = runHistory.data || [];
  const commits = gitHistory.data?.items || [];
  const error =
    runHistory.error || gitHistory.error || tags.error || more.error;
  const tagNames = (commit: string) =>
    (tags.data || [])
      .filter((tag) => tag.commit === commit)
      .map((tag) => tag.name);
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
              <WarningBadge count={run.warning_count || 0} />
              <span>{run.duration?.toFixed(2)} s</span>
              <ArrowRight size={15} />
            </button>
          ))}
        </>
      ) : (
        <>
          {commits.map((commit) => (
            <div className="history-row" key={commit.commit}>
              <GitCommitHorizontal size={21} />
              <span className="grow">
                <strong>{commit.message}</strong>
                <TagBadges names={tagNames(commit.commit)} />
                <small>
                  {commit.author}
                  {commit.assistant
                    ? ` ${t("assistantAttribution")}`
                    : ""} · {new Date(commit.date).toLocaleString()} ·{" "}
                  {commit.commit.slice(0, 8)}
                </small>
              </span>
              {!readOnly && (
                <button
                  className="button secondary small"
                  onClick={() => setTagCommit(commit.commit)}
                >
                  {t("createTag")}
                </button>
              )}
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
          ))}
          {gitHistory.data?.next != null && (
            <button
              className="button secondary"
              disabled={more.pending}
              onClick={() =>
                void more.run(async () => {
                  const from = gitHistory.data!;
                  const page = await api<HistoryPage>(
                    withQuery(`/worktrees/${worktree}/git/history`, {
                      ref: from.head,
                      offset: from.next!,
                      limit: 100,
                    }),
                  );
                  gitHistory.setData((current) =>
                    current === from
                      ? { ...page, items: [...from.items, ...page.items] }
                      : current,
                  );
                })
              }
            >
              {t(more.pending ? "loading" : "loadMore")}
            </button>
          )}
        </>
      )}
      {selected && (
        <Modal title={t("goToRun")} onClose={() => setSelected(null)} wide>
          <div className="modal-content">
            <div className="row gap">
              <span className={`badge ${selected.status}`}>
                {t(selected.status)}
              </span>
              <code>{selected.id}</code>
              <WarningBadge count={selected.warning_count || 0} />
              <span className="muted">
                {selected.environment} · {selected.commit.slice(0, 8)}
              </span>
            </div>
            <TagBadges names={tagNames(selected.commit)} />
            {!readOnly && selected.commit && (
              <button
                className="button secondary"
                onClick={() => setTagCommit(selected.commit)}
              >
                {t("tagRunCommit")}
              </button>
            )}
            {selected.error && <p className="notice error">{selected.error}</p>}
            {selected.requester && (
              <p>
                {t("runRequester")}:{" "}
                <strong>{selected.requester.username}</strong>
                {selected.requester.token_name && (
                  <>
                    {" "}
                    · {t("apiTokenName")}:{" "}
                    <strong>{selected.requester.token_name}</strong>
                  </>
                )}
              </p>
            )}
            {!!Object.keys(selected.variables || {}).length && (
              <section className="run-variables">
                <h4>{t("variables")}</h4>
                <VariableValues
                  variables={selected.variables || {}}
                  environment={selected.environment}
                  parameters={boundParameters(selected)}
                />
              </section>
            )}
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
                    requester: selected.requester,
                    started: selected.started,
                    finished: selected.finished,
                    connections: selected.connections,
                    definitions: selected.definitions,
                    node_sql: selected.node_sql,
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
                  <span className={`badge ${state.status}`}>
                    {t(state.status)}
                  </span>
                  <strong>{state.label}</strong>
                  <WarningBadge count={warningCount(state.results)} />
                  <span className="muted">{state.duration?.toFixed(3)} s</span>
                </summary>
                {state.error && <p className="notice error">{state.error}</p>}
                <ExecutionMessages results={state.results} />
                {state.external_outcome && (
                  <p className="notice">
                    {t("externalOutcome")}: {t(state.external_outcome)}
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
      {tagCommit && (
        <NewTagModal
          worktree={worktree}
          commit={tagCommit}
          onCreated={() => tags.reload()}
          onClose={() => setTagCommit(null)}
        />
      )}
    </section>
  );
}
