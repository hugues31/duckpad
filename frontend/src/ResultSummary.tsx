import { AlertTriangle, ChevronRight, Clock, Loader2 } from "lucide-react";
import { withQuery } from "./api";
import { executionFailures, wasBlocked } from "./executionFailures";
import { warningCount } from "./ExecutionMessages";
import { outputSource } from "./graph";
import { countLabel, useT, type TranslationKey } from "./i18n";
import { clock, computing, TAB_LABELS, type ResultsTab } from "./results";
import type { Dataset, Snapshot, Statuses } from "./types";
import { useApiResource } from "./useApiResource";
import { useOptionalWorktree, usePartitionQuery } from "./worktree";

/**
 * One line on what the node produced in the selected environment, under the
 * inspector's node heading. The details live in the results panel: each part
 * opens its matching tab.
 */
export default function ResultSummary({
  bundle,
  fullNode,
  ports,
  hasInputs = false,
  statuses,
  onOpen,
}: {
  bundle: Snapshot["bundle"];
  fullNode: string;
  /** The output ports the node declares. */
  ports: string[];
  hasInputs?: boolean;
  statuses: Statuses;
  onOpen: (tab: ResultsTab) => void;
}) {
  const t = useT();
  const worktree = useOptionalWorktree();
  const partition = usePartitionQuery(fullNode, ports[0]);
  const preview = useApiResource<Dataset>(
    worktree && partition.manifest && ports.length > 0
      ? withQuery(
          `/worktrees/${worktree.id}/preview/${encodeURIComponent(fullNode)}`,
          {
            environment: worktree.environment,
            port: ports[0],
            limit: 1,
            ...partition,
          },
        )
      : null,
    { refresh: JSON.stringify(statuses) },
  );
  // A component instance stores no rows: its outputs are those of nodes inside it.
  const sources = ports.map((port) =>
    bundle ? outputSource(bundle, fullNode, port) : { node: fullNode, port },
  );
  const datasets = partition.manifest
    ? preview.data
      ? [preview.data]
      : []
    : sources.flatMap((source): Dataset[] => {
        const dataset = statuses.nodes[source.node]?.outputs?.[source.port];
        return dataset ? [dataset] : [];
      });
  // As in the results panel, which opens on the first output.
  const result = statuses.nodes[sources[0]?.node ?? fullNode];
  // Also a failure inside a component whose first output succeeded.
  const failed = executionFailures(statuses, fullNode).length > 0;
  const running = computing(statuses, fullNode);
  // A blocked node says so, as on the canvas; a failed one keeps the state of its rows.
  const status =
    failed && wasBlocked(statuses, fullNode)
      ? "blocked"
      : datasets.length
        ? datasets.some((dataset) => dataset.incomplete)
          ? "incomplete"
          : datasets.every((dataset) => dataset.status === "valid")
            ? "valid"
            : "stale"
        : result?.execution_status;
  const messages = warningCount(
    result?.results?.filter((item) => item.origin.kind !== "test"),
  );
  const tests = (result?.results || []).filter(
    (item) => item.origin.kind === "test" && item.status !== "ok",
  ).length;
  const created = datasets.map((dataset) => dataset.created).sort();
  const latest = created[created.length - 1];
  const tabTitle = (tab: ResultsTab) =>
    `${t("results")} · ${t(TAB_LABELS[tab])}`;
  const count = (value: number, one: TranslationKey, many: TranslationKey) =>
    countLabel(t, value, one, many);
  return (
    <div
      className="result-summary"
      role="group"
      aria-label={t("resultSummary")}
    >
      {running ? (
        <span className="badge running">
          <Loader2 size={11} className="spin" aria-hidden="true" />
          {t("running")}
        </span>
      ) : (
        status && (
          <button
            className={`badge ${status}`}
            title={tabTitle(ports.length ? "data" : "log")}
            onClick={() => onOpen(ports.length ? "data" : "log")}
          >
            {t(status)}
          </button>
        )
      )}
      {ports.length > 0 && (
        <button
          className="summary-link"
          title={tabTitle("data")}
          onClick={() => onOpen("data")}
        >
          {count(ports.length, "summaryOutput", "summaryOutputs")}
        </button>
      )}
      {!status && !running && !result?.error && (
        <span className="muted">{t("noResultYet")}</span>
      )}
      {(failed || result?.error) && (
        <button
          className="summary-link danger"
          title={tabTitle("log")}
          onClick={() => onOpen("log")}
        >
          {t("lastRunFailed")}
        </button>
      )}
      {messages > 0 && (
        <button
          className="warning-badge"
          title={tabTitle("log")}
          onClick={() => onOpen("log")}
        >
          <AlertTriangle size={12} aria-hidden="true" />
          {count(messages, "summaryMessage", "summaryMessages")}
        </button>
      )}
      {tests > 0 && (
        <button
          className="warning-badge"
          title={tabTitle("tests")}
          onClick={() => onOpen("tests")}
        >
          <AlertTriangle size={12} aria-hidden="true" />
          {count(tests, "summaryTest", "summaryTests")}
        </button>
      )}
      {latest && (
        <button
          className="summary-link muted"
          title={tabTitle("log")}
          onClick={() => onOpen("log")}
        >
          <Clock size={11} aria-hidden="true" />
          {t("runAt").replace("{time}", clock(latest))}
        </button>
      )}
      <button
        className="summary-link results-link"
        onClick={() => onOpen(ports.length || hasInputs ? "data" : "log")}
      >
        {t("results")}
        <ChevronRight size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
