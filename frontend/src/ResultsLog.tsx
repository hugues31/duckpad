import { lazy, Suspense, useState } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  CircleCheck,
  CircleDot,
  CircleX,
  GitCommitHorizontal,
  History,
  Info,
  Upload,
  User,
} from "lucide-react";
import AskAssistant from "./AskAssistant";
import ExportDownload from "./ExportDownload";
import { WarningBadge } from "./ExecutionMessages";
import { useT } from "./i18n";
import { worktreeUrl } from "./navigation";
import { clock, seconds } from "./ResultsPanel";
import type {
  ExecutionResult,
  NodeResult,
  Run,
  Snapshot,
  Statuses,
} from "./types";
import { useApiResource } from "./useApiResource";
import { StatementVariables } from "./VariableFields";

const CodeEditor = lazy(() => import("./Editor"));
const FILTERS = ["all", "messages", "warnings", "errors"] as const;
type LogFilter = (typeof FILTERS)[number];
const FILTER_LABELS = {
  all: "log_all",
  messages: "log_messages",
  warnings: "log_warnings",
  errors: "log_errors",
} as const;
const OUTCOMES = {
  completed: "outcome_completed",
  failed: "outcome_failed",
  "partial or unknown": "outcome_partial_or_unknown",
  unknown: "outcome_unknown",
} as const;

interface Entry {
  time?: string;
  level: "info" | "warning" | "error" | "success" | "step";
  message: React.ReactNode;
  detail?: React.ReactNode;
  aside?: React.ReactNode;
  kind: "step" | "message" | "test";
}

/** The story of the run behind the displayed result: summary, timeline and executed SQL. */
export default function ResultsLog({
  snapshot,
  environment,
  fullNode,
  exportNode,
  download,
  result,
  inputs,
  statuses,
  onTests,
}: {
  snapshot: Snapshot;
  environment: string;
  fullNode: string;
  exportNode: boolean;
  download: boolean;
  result?: NodeResult;
  inputs: { node: string; port: string; input: string; label: string }[];
  statuses: Statuses;
  onTests: () => void;
}) {
  const t = useT();
  const worktree = snapshot.worktree.id;
  const [filter, setFilter] = useState<LogFilter>("all");
  // The latest attempt: a failed run after the retained result, or the run that produced it.
  const runId = (result?.error && result.error_run) || result?.result_run;
  const loaded = useApiResource<Run>(
    runId ? `/runs/${encodeURIComponent(runId)}` : null,
    {
      refresh: JSON.stringify(result),
    },
  );
  const run = loaded.data?.id === runId ? loaded.data : null;
  const state = run?.nodes?.[fullNode];
  if (!runId)
    return (
      <div className="results-empty-tab">
        <Info size={18} aria-hidden="true" />
        <div>
          <strong>{t("notRunHere")}</strong>
          <p className="muted small">
            {t(exportNode ? "exportNotRun" : "noResultHint")}
          </p>
        </div>
      </div>
    );
  if (!run || !state)
    return loaded.error ? (
      <div className="inline-error">{loaded.error}</div>
    ) : (
      <p className="muted small results-note">{t("loading")}</p>
    );
  const results = state.results || [];
  const messages = results.filter((item) => item.origin.kind !== "test");
  const tests = results.filter((item) => item.origin.kind === "test");
  const entries: Entry[] = [];
  entries.push({
    kind: "step",
    level: "step",
    time: state.started,
    message: t("logStarted"),
    detail: inputs.length
      ? inputs
          .map((input) => {
            const count =
              run.nodes[input.node]?.outputs?.[input.port]?.count ??
              statuses.nodes[input.node]?.outputs?.[input.port]?.count;
            return `${input.input} ← ${input.label}${count !== undefined ? ` · ${count.toLocaleString()} ${t("rows")}` : ""}`;
          })
          .join(", ")
      : undefined,
  });
  for (const [port, output] of Object.entries(state.outputs || {}))
    entries.push({
      kind: "step",
      level: "success",
      time: output.created,
      message: (
        <>
          {t("logComputedOutput")} <code>{port}</code>
        </>
      ),
      detail: `${output.count.toLocaleString()} ${t("rows")} · ${output.columns.length} ${t("columns")}`,
      aside:
        typeof output.duration === "number"
          ? seconds(output.duration)
          : undefined,
    });
  for (const item of messages)
    entries.push({
      kind: "message",
      level: item.level,
      message: item.omitted
        ? t("moreMessages").replace("{count}", String(item.omitted))
        : item.message,
      detail: item.omitted
        ? undefined
        : [
            item.origin.name ||
              t("messageBlock").replace("{block}", String(item.origin.block)),
            item.output,
          ]
            .filter(Boolean)
            .join(" · "),
      aside: levelLabel(item, t),
    });
  if (tests.length) {
    const failed = tests.filter((item) => item.status !== "ok");
    const worst = failed.some((item) => item.level === "error")
      ? "error"
      : failed.length
        ? "warning"
        : "info";
    entries.push({
      kind: "test",
      level: worst,
      message: (
        <>
          {t("logTests").replace(
            "{count}",
            String(tests.length - failed.length),
          )}
          {failed.map((item) => (
            <span key={item.origin.name}>
              , <strong>{item.origin.name}</strong>{" "}
              {t("logTestFailed").replace("{count}", String(item.observed))}
            </span>
          ))}
        </>
      ),
      detail: (
        <button className="text-button" onClick={onTests}>
          {t("seeTests")}
        </button>
      ),
      aside:
        worst === "info"
          ? t("testOK")
          : t(worst === "error" ? "messageError" : "messageWarning"),
    });
  }
  if (state.status === "success")
    entries.push({
      kind: "step",
      level: "success",
      time: state.finished,
      message: exportNode ? t("logExported") : t("logPublished"),
      aside:
        typeof state.duration === "number"
          ? seconds(state.duration)
          : undefined,
    });
  else if (
    state.status === "failed" ||
    state.status === "blocked" ||
    state.status === "canceled"
  )
    entries.push({
      kind: "step",
      level: "error",
      time: state.finished,
      message: state.error || t(state.status),
      aside: t(state.status),
    });
  const counts = {
    all: entries.length,
    messages: messages.length,
    warnings: entries.filter((entry) => entry.level === "warning").length,
    errors: entries.filter((entry) => entry.level === "error").length,
  };
  const shown = entries.filter((entry) =>
    filter === "all"
      ? true
      : filter === "messages"
        ? entry.kind === "message"
        : filter === "warnings"
          ? entry.level === "warning"
          : entry.level === "error",
  );
  const statements = state.statements || [];
  const requester = run.requester?.username || run.job?.name;
  const current = result?.outputs
    ? Object.values(result.outputs).every(
        (dataset) => dataset.status === "valid",
      )
    : false;
  return (
    <div className="results-log">
      <div className="results-toolbar">
        <div className="segmented" role="group" aria-label={t("logFilter")}>
          {FILTERS.map((key) => (
            <button
              key={key}
              className={filter === key ? "active" : ""}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {t(FILTER_LABELS[key])}{" "}
              <span className="tab-count">{counts[key]}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <Link
          className="text-button"
          to={worktreeUrl(worktree, "history", environment, { run: run.id })}
        >
          <History size={12} aria-hidden="true" />
          {t("openRunInHistory")}
        </Link>
      </div>
      <div className="data-scroll log-scroll">
        {state.error && (
          <div className="notice error log-error">
            <p>{state.error}</p>
            <AskAssistant
              node={fullNode}
              run={run.id}
              environment={environment}
            />
          </div>
        )}
        <div className="run-summary">
          <span className={`badge ${state.status}`}>{t(state.status)}</span>
          {state.started && (
            <span>
              {new Date(state.started).toLocaleString()}
              {state.finished && ` → ${clock(state.finished)}`}
              {typeof state.duration === "number" && (
                <span className="muted"> {seconds(state.duration)}</span>
              )}
            </span>
          )}
          <span>
            <GitCommitHorizontal size={12} aria-hidden="true" />
            <code>{run.commit.slice(0, 7)}</code>{" "}
            <span className="muted">
              {t(current ? "currentConfiguration" : "earlierConfiguration")}
            </span>
          </span>
          {requester && (
            <span>
              <User size={12} aria-hidden="true" /> {requester}{" "}
              <span className="muted">
                {t(
                  run.trigger === "job"
                    ? "triggerJob"
                    : run.entry_point === "assistant"
                      ? "triggerAssistant"
                      : "triggerManual",
                )}
                {" · "}
                {run.scope === "project" ? t("wholeProject") : t("nodeScope")}
              </span>
            </span>
          )}
          <WarningBadge count={run.warning_count || 0} />
        </div>
        <ol className="log-timeline">
          {shown.map((entry, index) => {
            const Icon = {
              step: CircleDot,
              success: CircleCheck,
              info: Info,
              warning: AlertTriangle,
              error: CircleX,
            }[entry.level];
            return (
              <li key={index} className={`log-entry ${entry.level}`}>
                <time>{entry.time ? clock(entry.time) : ""}</time>
                <Icon size={14} aria-hidden="true" />
                <div>
                  <span>{entry.message}</span>
                  {entry.detail && <small>{entry.detail}</small>}
                </div>
                <span className="muted small">{entry.aside}</span>
              </li>
            );
          })}
        </ol>
        {exportNode && (
          <section className="log-export">
            <h4>
              <Upload size={13} aria-hidden="true" /> {t("exportOutcome")}
            </h4>
            {state.external_outcome && (
              <p className="small">{t(OUTCOMES[state.external_outcome])}</p>
            )}
            {download && (
              <ExportDownload
                key={`${worktree}:${environment}:${fullNode}:${run.id}`}
                worktree={worktree}
                environment={environment}
                node={fullNode}
              />
            )}
          </section>
        )}
        {statements.length > 0 && (
          <details className="executed-sql">
            <summary>{t("executedSqlTitle")}</summary>
            <Suspense fallback={<p>{t("loading")}</p>}>
              <CodeEditor
                value={statements
                  .map((s) =>
                    s.materialization_sql
                      ? s.materialization_sql.join(";\n") + ";"
                      : s.sql + ";",
                  )
                  .join("\n\n")}
                readOnly
                height="260px"
              />
            </Suspense>
            <StatementVariables
              statements={statements}
              environment={run.environment}
            />
            {statements.some(
              (s) => Object.keys(s.bindings || {}).length > 0,
            ) && (
              <>
                <h4>{t("bindings")}</h4>
                <pre className="expression">
                  {JSON.stringify(
                    Object.assign({}, ...statements.map((s) => s.bindings)),
                    null,
                    2,
                  )}
                </pre>
              </>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

function levelLabel(item: ExecutionResult, t: ReturnType<typeof useT>) {
  return t(
    item.level === "info"
      ? "messageInfo"
      : item.level === "warning"
        ? "messageWarning"
        : "messageError",
  );
}
