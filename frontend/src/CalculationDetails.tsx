import { X } from "lucide-react";
import { useState } from "react";
import { api, send } from "./api";
import { formatValue } from "./graph";
import { useT } from "./i18n";
import { cellId, type Entry, type Explanation } from "./lineageGraph";
import { displayNodeName } from "./nodeNames";
import Pager from "./Pager";
import { useResource } from "./useApiResource";
import { VariableValues } from "./VariableFields";
import { useOptionalWorktree } from "./worktree";

export function CalculationDetails({
  entry,
  worktree,
  environment,
  onClose,
}: {
  entry: Entry;
  worktree: string;
  environment: string;
  onClose: () => void;
}) {
  const t = useT();
  const names = useOptionalWorktree()?.snapshot?.node_names;
  const selections = [entry.result, ...entry.hidden].filter(
    (step) => step.context_total > 0,
  );
  const [selection, setSelection] = useState(0);
  const [offset, setOffset] = useState(0);
  const current = selections[selection];
  const {
    data: page,
    error,
    pending,
  } = useResource(
    current
      ? JSON.stringify([
          worktree,
          environment,
          current.dataset,
          current.row,
          current.column,
          offset,
        ])
      : null,
    (signal) =>
      api<Explanation>(`/worktrees/${worktree}/lineage`, {
        ...send({
          dataset: current!.dataset,
          row: current!.row,
          column: current!.column,
          environment,
          context: true,
          partition_context: current!.partition_context,
          offset,
        }),
        signal,
      }),
  );
  return (
    <aside
      className="lineage-details"
      aria-label={t("lineageCalculationDetails")}
    >
      <div className="row spread">
        <h3>{entry.result.column}</h3>
        <button
          className="icon"
          aria-label={t("lineageCloseDetails")}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </div>
      <p>
        {displayNodeName(
          names?.[entry.result.node || ""],
          entry.result.node || "",
          t,
        )}{" "}
        · {entry.result.port} · {t("lineageRow")} {entry.result.row + 1}
      </p>
      {entry.result.variables &&
        Object.keys(entry.result.variables).length > 0 && (
          <VariableValues
            variables={entry.result.variables}
            environment={entry.result.environment || ""}
          />
        )}
      {entry.result.expression && entry.result.kind !== "python" && (
        <pre className="expression">{entry.result.expression}</pre>
      )}
      {entry.result.warnings.map((warning) => (
        <p className="notice warning" key={warning}>
          {warning}
        </p>
      ))}
      {!!selections.length && (
        <>
          <h4>{t("lineageSelection")}</h4>
          <p>{t("lineageContextHint")}</p>
          {selections.length > 1 && (
            <label>
              {t("lineageSelectionStep")}
              <select
                value={selection}
                onChange={(event) => {
                  setSelection(Number(event.target.value));
                  setOffset(0);
                }}
              >
                {selections.map((step, index) => (
                  <option key={cellId(step)} value={index}>
                    {displayNodeName(
                      names?.[step.node || ""],
                      step.node || "",
                      t,
                    )}{" "}
                    · {step.column}
                  </option>
                ))}
              </select>
            </label>
          )}
          {current?.calculation?.selection?.map((condition) => (
            <pre className="expression" key={condition}>
              {condition}
            </pre>
          ))}
          {pending && <p role="status">{t("loading")}</p>}
          {error && <p role="alert">{error}</p>}
          {page && (
            <>
              <table>
                <thead>
                  <tr>
                    <th>{t("lineageInput")}</th>
                    <th>{t("lineageValue")}</th>
                    <th>{t("lineageRow")}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.contributions.map((item) => (
                    <tr key={cellId(item)}>
                      <td>{item.column}</td>
                      <td>{formatValue(item.value)}</td>
                      <td>{item.row + 1}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {page.total > page.page_size && (
                <Pager
                  className="lineage-page"
                  between
                  offset={offset}
                  total={page.total}
                  pageSize={page.page_size}
                  onOffset={setOffset}
                />
              )}
            </>
          )}
        </>
      )}
    </aside>
  );
}
