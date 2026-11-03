import { Fragment, useState } from "react";
import { Link } from "react-router";
import {
  AlertTriangle,
  CircleCheck,
  CircleX,
  Code2,
  Eye,
  History,
  Info,
} from "lucide-react";
import { withQuery } from "./api";
import type { NodeInterface } from "./graph";
import { countLabel, useT } from "./i18n";
import { worktreeUrl } from "./navigation";
import { nodeCode } from "./nodeCode";
import { clock } from "./ResultsPanel";
import { testSource } from "./samples";
import type {
  ExecutionResult,
  FlowNode,
  NodeResult,
  Snapshot,
  TestExecution,
} from "./types";
import { useApiResource } from "./useApiResource";

const HISTORY = 10;

/** The tests a node's code declares, in declaration order. */
export function declaredTests(signature: NodeInterface) {
  if (signature.kind === "component") return [];
  return (signature.definition?.blocks || []).flatMap((block) =>
    block.test_name ? [block.test_name] : [],
  );
}

const STATUS_ICONS = {
  ok: CircleCheck,
  warning: AlertTriangle,
  error: CircleX,
};

/** Each `-- @test` of the node with its latest outcome, recent history and failing rows on demand. */
export default function ResultsTests({
  snapshot,
  environment,
  node,
  parent,
  fullNode,
  tests,
  result,
  refresh,
  canShowRows,
  readOnly,
  onShowRows,
  onEditCode,
}: {
  snapshot: Snapshot;
  environment: string;
  node: FlowNode;
  parent?: string;
  fullNode: string;
  tests: string[];
  result?: NodeResult;
  refresh: string;
  canShowRows: boolean;
  /** Readers open the node code read-only. */
  readOnly: boolean;
  onShowRows: (test: string, count: number, output?: string | null) => void;
  onEditCode: () => void;
}) {
  const t = useT();
  const worktree = snapshot.worktree.id;
  const [open, setOpen] = useState<string | null>(null);
  const history = useApiResource<TestExecution[]>(
    tests.length
      ? withQuery(
          `/worktrees/${worktree}/test-history/${encodeURIComponent(fullNode)}`,
          {
            environment,
            limit: HISTORY,
          },
        )
      : null,
    { refresh },
  );
  const code =
    snapshot.bundle && !node.component
      ? nodeCode(snapshot.bundle, node, parent)
      : "";
  const executions = history.data || [];
  const latest = executions[0];
  const outcome = (execution: TestExecution | undefined, name: string) =>
    execution?.results.find((item) => item.origin.name === name);
  const current = (name: string): ExecutionResult | undefined =>
    outcome(latest, name) ||
    (result?.results || []).find(
      (item) => item.origin.kind === "test" && item.origin.name === name,
    );
  const counts = { ok: 0, warning: 0, error: 0 };
  for (const name of tests) {
    const status = current(name)?.status;
    if (status) counts[status] += 1;
  }
  if (!tests.length)
    return (
      <div className="results-empty-tab">
        <Info size={18} aria-hidden="true" />
        <div>
          <strong>{t("noTests")}</strong>
          <p className="muted small">{t("noTestsHint")}</p>
          <pre className="expression">
            {
              "-- @test amount_present: error\nSELECT * FROM {{ result }} WHERE amount IS NULL;"
            }
          </pre>
          <p className="muted small">{t("testFromFilterTip")}</p>
          {!node.component && (
            <button className="button secondary small" onClick={onEditCode}>
              <Code2 size={13} aria-hidden="true" />
              {t(readOnly ? "viewNodeCode" : "editNodeCode")}
            </button>
          )}
        </div>
      </div>
    );
  return (
    <div className="results-tests">
      <div className="results-toolbar">
        <span className="tests-summary">
          <span className="ok">
            <CircleCheck size={13} aria-hidden="true" />
            {countLabel(t, counts.ok, "testsPassedOne", "testsPassed")}
          </span>
          <span className="warning">
            <AlertTriangle size={13} aria-hidden="true" />
            {countLabel(t, counts.warning, "testsWarningsOne", "testsWarnings")}
          </span>
          <span className="error">
            <CircleX size={13} aria-hidden="true" />
            {countLabel(t, counts.error, "testsErrorsOne", "testsErrors")}
          </span>
          {latest && (
            <span className="muted">
              · {t("testsCheckedBy").replace("{time}", clock(latest.started))}
            </span>
          )}
        </span>
        <span className="spacer" />
        {!node.component && (
          <button className="text-button" onClick={onEditCode}>
            <Code2 size={12} aria-hidden="true" />
            {t(readOnly ? "viewNodeCode" : "editTestsInCode")}
          </button>
        )}
      </div>
      {history.error && <div className="inline-error">{history.error}</div>}
      <div className="data-scroll">
        <table className="tests-table">
          <thead>
            <tr>
              <th>{t("status")}</th>
              <th>{t("test")}</th>
              <th>{t("testSeverity")}</th>
              <th>{t("output")}</th>
              <th className="number">{t("failingRows")}</th>
              <th>{t("lastRuns").replace("{count}", String(HISTORY))}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tests.map((name) => {
              const item = current(name);
              const status = item?.status;
              const Icon = status ? STATUS_ICONS[status] : Info;
              const observed = Number(item?.observed ?? 0);
              const source = testSource(code, name);
              const severity =
                source?.match(/@test\s+\w+\s*:\s*(warning|error)/)?.[1] ||
                "error";
              const recent = executions.slice(0, HISTORY).reverse();
              let failingRuns = 0;
              for (const execution of executions) {
                const found = outcome(execution, name);
                if (!found || found.status === "ok") break;
                failingRuns += 1;
              }
              const since = failingRuns
                ? executions[failingRuns - 1]
                : undefined;
              const expanded = open === name;
              return (
                <Fragment key={name}>
                  <tr
                    className={`test-row ${status || "none"} ${expanded ? "open" : ""}`}
                  >
                    <td>
                      <button
                        className={`test-status ${status || "none"}`}
                        aria-expanded={expanded}
                        onClick={() => setOpen(expanded ? null : name)}
                      >
                        <Icon size={13} aria-hidden="true" />
                        {status === "ok"
                          ? t("testOK")
                          : status === "warning"
                            ? t("messageWarning")
                            : status === "error"
                              ? t("messageError")
                              : t("notRun")}
                      </button>
                    </td>
                    <td>
                      <code>{name}</code>
                    </td>
                    <td>
                      {t(
                        severity === "warning"
                          ? "messageWarning"
                          : "messageError",
                      )}
                    </td>
                    <td>{item?.output || ""}</td>
                    <td className="number">
                      {item ? observed.toLocaleString() : ""}
                    </td>
                    <td>
                      <span
                        className="test-strip"
                        aria-label={t("lastRuns").replace(
                          "{count}",
                          String(HISTORY),
                        )}
                      >
                        {Array.from(
                          { length: HISTORY - recent.length },
                          (_, index) => (
                            <span key={`empty-${index}`} className="dot none" />
                          ),
                        )}
                        {recent.map((execution) => {
                          const found = outcome(execution, name);
                          return (
                            <span
                              key={execution.run}
                              className={`dot ${found?.status || "none"}`}
                              title={`${new Date(execution.started).toLocaleString()} · ${found ? found.message : t("notRun")}`}
                            />
                          );
                        })}
                      </span>
                    </td>
                    <td>
                      {status && status !== "ok" && observed > 0 && (
                        <button
                          className="text-button"
                          disabled={!canShowRows}
                          title={
                            canShowRows
                              ? undefined
                              : t("failingRowsUnavailable")
                          }
                          onClick={() =>
                            onShowRows(name, observed, item?.output)
                          }
                        >
                          <Eye size={12} aria-hidden="true" />
                          {t("showFailingRows").replace(
                            "{count}",
                            observed.toLocaleString(),
                          )}
                        </button>
                      )}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className="test-details">
                      <td colSpan={7}>
                        {source && <pre className="expression">{source}</pre>}
                        <div className="row gap">
                          <span className="muted small">
                            {since
                              ? countLabel(
                                  t,
                                  failingRuns,
                                  "failingSinceOne",
                                  "failingSince",
                                ).replace(
                                  "{time}",
                                  new Date(since.started).toLocaleString(),
                                )
                              : status === "ok"
                                ? t("testPassing")
                                : ""}{" "}
                            {status === "warning" && t("warningTestHint")}
                          </span>
                          <span className="spacer" />
                          {latest && (
                            <Link
                              className="text-button"
                              to={worktreeUrl(
                                worktree,
                                "history",
                                environment,
                                { run: latest.run },
                              )}
                            >
                              <History size={12} aria-hidden="true" />
                              {t("openRunInHistory")}
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        <p className="muted small results-note">
          <Info size={12} aria-hidden="true" /> {t("failingRowsNote")}
        </p>
      </div>
    </div>
  );
}
