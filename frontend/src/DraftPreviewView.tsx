import { useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Play } from "lucide-react";
import type { PreviewState } from "./draftPreview";
import { formatValue } from "./graph";
import { useT } from "./i18n";
import { seconds } from "./ResultsPanel";
import Select from "./Select";

const PAGE_SIZE = 100;

/**
 * The outputs of a node computed from samples of its inputs. Nothing was
 * saved, published or recorded: the panel says so and offers to compute the
 * missing inputs.
 */
export default function DraftPreviewView({
  preview,
  canRun,
  running,
  inputName,
  onRunAncestors,
}: {
  preview: PreviewState;
  /** Whether the user may run the ancestors now. */
  canRun: boolean;
  running: boolean;
  /** The name of an upstream node, as the canvas shows it. */
  inputName: (node: string) => string;
  onRunAncestors: () => void;
}) {
  const t = useT();
  const result = preview.result;
  const [port, setPort] = useState("");
  const [offset, setOffset] = useState(0);
  const output =
    result?.outputs.find((item) => item.port === port) || result?.outputs[0];
  const stale = (result?.inputs || []).filter(
    (input) => input.status !== "valid",
  );
  const skipped = result
    ? result.skipped.tests + result.skipped.messages + result.skipped.exports
    : 0;
  const rows = output?.rows || [];
  const total = rows.length;
  const start = Math.min(offset, Math.max(0, total - 1));
  return (
    <div
      className="draft-preview"
      aria-busy={preview.pending}
      data-pending={preview.pending || undefined}
    >
      <div className="draft-preview-bar" role="status">
        <span className="badge draft">{t("results_preview")}</span>
        {preview.pending ? (
          <span className="muted small">
            <Loader2 size={12} className="spin" aria-hidden="true" />{" "}
            {t("previewRunning")}
          </span>
        ) : (
          result && (
            <span className="muted small">
              {result.rows === null
                ? t("previewSummaryAll")
                : t("previewSummary").replace(
                    "{rows}",
                    result.rows.toLocaleString(),
                  )}
              <span className="draft-preview-time">
                {" · "}
                {result.duration < 1
                  ? `${Math.max(1, Math.round(result.duration * 1000))} ms`
                  : seconds(result.duration)}
              </span>
            </span>
          )
        )}
        {result && result.outputs.length > 1 && (
          <Select
            className="dataset-select"
            aria-label={t("output")}
            value={output?.port}
            onChange={(event) => {
              setPort(event.target.value);
              setOffset(0);
            }}
          >
            {result.outputs.map((item) => (
              <option key={item.port} value={item.port}>
                {item.port}
              </option>
            ))}
          </Select>
        )}
      </div>
      {preview.error && !preview.pending && (
        <div className="notice error draft-preview-error" role="alert">
          <p>
            {preview.missing?.length
              ? t("previewMissingInputs").replace(
                  "{inputs}",
                  preview.missing
                    .map((item) => `${item.input} ← ${inputName(item.node)}`)
                    .join(", "),
                )
              : preview.diagnostic
                ? t("previewErrorAt")
                    .replace("{line}", String(preview.diagnostic.line))
                    .replace("{message}", preview.diagnostic.message)
                : preview.error}
          </p>
          {!!preview.missing?.length && (
            <button
              className="button secondary small"
              disabled={!canRun}
              aria-busy={running}
              onClick={onRunAncestors}
            >
              {running ? (
                <Loader2 size={14} className="spin" aria-hidden="true" />
              ) : (
                <Play size={14} aria-hidden="true" />
              )}
              {t("runAncestors")}
            </button>
          )}
        </div>
      )}
      {!!stale.length && (
        <div className="stale-reason">
          {t("previewStaleInputs").replace(
            "{inputs}",
            stale.map((item) => item.input).join(", "),
          )}
        </div>
      )}
      {result && !result.outputs.length && (
        <p className="empty-small">{t("previewNoOutput")}</p>
      )}
      {output && (
        <>
          <div className="data-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="row-number">#</th>
                  {output.columns.map((column) => (
                    <th key={column.name} data-column={column.name}>
                      <span className="column-heading">
                        <span>{column.name}</span>
                        <small>{column.type}</small>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.slice(start, start + PAGE_SIZE).map((row, index) => (
                  <tr key={start + index}>
                    <td className="row-number">{start + index + 1}</td>
                    {row.map((value, i) => (
                      <td key={i}>
                        <span
                          className={`cell-text ${value === null ? "null" : ""}`}
                        >
                          {formatValue(value)}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!total && <p className="empty-small">{t("previewNoRows")}</p>}
          </div>
          <div className="preview-footer">
            <span>
              {skipped > 0 ? t("previewSkipped") : t("previewNotSaved")}
            </span>
            <div className="row">
              <span>
                {total
                  ? `${start + 1}–${Math.min(start + PAGE_SIZE, total)}`
                  : "0"}{" "}
                /{" "}
                {(output.truncated
                  ? t("previewMoreRows")
                  : output.count > total
                    ? t("previewFirstRows")
                    : "{count}"
                )
                  .replace("{count}", output.count.toLocaleString())
                  .replace("{shown}", total.toLocaleString())}
              </span>
              <button
                className="icon"
                disabled={!start}
                title={t("previous")}
                aria-label={t("previous")}
                onClick={() => setOffset(Math.max(0, start - PAGE_SIZE))}
              >
                <ChevronLeft size={15} />
              </button>
              <button
                className="icon"
                disabled={start + PAGE_SIZE >= total}
                title={t("next")}
                aria-label={t("next")}
                onClick={() => setOffset(start + PAGE_SIZE)}
              >
                <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
