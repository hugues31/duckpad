import { useCallback, useState } from "react";
import { useAssistantError } from "./assistantErrors";
import { api, send } from "./api";
import type { AssistantTool } from "./assistantTypes";
import { useT } from "./i18n";
import type { Run } from "./types";
import { usePolling } from "./usePolling";
import { VariableValues } from "./VariableFields";

export interface RunControls {
  canApprove?: boolean;
  canCancel?: boolean;
  onDecision?: (tool: string, approved: boolean) => void;
}

export function AssistantRun({
  tool,
  canApprove,
  canCancel,
  onDecision,
}: { tool: AssistantTool } & RunControls) {
  const t = useT();
  const explainError = useAssistantError();
  const [run, setRun] = useState(tool.run);
  const [error, setError] = useState("");
  const [canceling, setCanceling] = useState(false);
  const active =
    run && ["preparing", "running", "canceling"].includes(run.status);
  usePolling(
    useCallback(
      async (signal) => {
        if (!tool.run) return false;
        try {
          const value = await api<Run>(`/runs/${tool.run.id}`, { signal });
          if (!signal.aborted) {
            setRun(value);
            setError("");
          }
          return ["preparing", "running", "canceling"].includes(value.status);
        } catch (e) {
          if (!signal.aborted) setError((e as Error).message);
          throw e;
        }
      },
      [tool.run],
    ),
    { interval: 1000, enabled: !!tool.run },
  );
  const approval = tool.approval;
  let failure = "";
  if (tool.status === "error") {
    try {
      failure = String(JSON.parse(tool.summary).error || "");
    } catch {
      failure = tool.summary;
    }
  }
  if (!approval) return null;
  return (
    <div className="assistant-run">
      <strong>{t("assistantRunConfirmation")}</strong>
      {approval.error ? (
        <p className="notice error">{explainError(approval.error)}</p>
      ) : (
        <>
          <p>
            {t("environment")}: <strong>{approval.environment}</strong> ·{" "}
            {t("assistantRunScope")}:{" "}
            <strong>{approval.node || t("assistantEntireFlow")}</strong>
          </p>
          <p className="muted">
            {t("assistantRunNodes").replace(
              "{count}",
              String(approval.node_count),
            )}
          </p>
          {approval.confirm_before_run && (
            <p className="notice">{t("confirmRunHint")}</p>
          )}
          {!!Object.keys(approval.variables || {}).length && (
            <>
              <h4>
                {t("variablesUsedByRun").replace(
                  "{environment}",
                  approval.environment || "",
                )}
              </h4>
              <VariableValues
                variables={approval.variables || {}}
                environment={approval.environment || ""}
              />
            </>
          )}
          {!!approval.exports?.length && (
            <div className="notice error">
              <strong>{t("assistantIrreversibleExports")}</strong>
              <ul>
                {approval.exports.map((item) => (
                  <li key={item.node}>
                    {item.label} ({item.node})
                    {item.connections.length
                      ? ` · ${item.connections.join(", ")}`
                      : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {approval.decision === null ? (
        <div className="assistant-action-buttons">
          <button
            type="button"
            className="button primary small"
            disabled={!canApprove || !!approval.error}
            onClick={() => onDecision?.(tool.id, true)}
          >
            {t("confirmAndRun")}
          </button>
          <button
            type="button"
            className="button secondary small"
            disabled={!onDecision}
            onClick={() => onDecision?.(tool.id, false)}
          >
            {t("assistantDeclineRun")}
          </button>
        </div>
      ) : (
        <p className="muted">
          {t(
            approval.decision ? "assistantRunApproved" : "assistantRunDeclined",
          )}
        </p>
      )}
      {run && (
        <div className="assistant-run-status" role="status">
          <code>{run.id}</code> ·{" "}
          <span className={`badge ${run.status}`}>{t(run.status)}</span>
          {active && (
            <button
              type="button"
              className="button secondary small"
              disabled={!canCancel || canceling || run.status === "canceling"}
              onClick={() => {
                setCanceling(true);
                void api<Run>(`/runs/${run.id}/cancel`, send({}))
                  .then(setRun)
                  .catch((e: Error) => setError(e.message))
                  .finally(() => setCanceling(false));
              }}
            >
              {t("assistantCancelRun")}
            </button>
          )}
          {active && <p className="muted">{t("cancelRunHint")}</p>}
        </div>
      )}
      {failure && (
        <p className="notice error" role="alert">
          {explainError(failure)}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
