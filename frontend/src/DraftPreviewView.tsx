import { Loader2, Play } from "lucide-react";
import { useState } from "react";
import DataGrid from "./DataGrid";
import type { PreviewState } from "./draftPreview";
import { useT } from "./i18n";
import Pager from "./Pager";
import { seconds } from "./results";
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
          <DataGrid
            columns={output.columns}
            rows={rows
              .slice(start, start + PAGE_SIZE)
              .map((values, index) => ({ id: start + index, values }))}
            offset={start}
          >
            {!total && <p className="empty-small">{t("previewNoRows")}</p>}
          </DataGrid>
          <div className="preview-footer">
            <span>
              {skipped > 0 ? t("previewSkipped") : t("previewNotSaved")}
            </span>
            <Pager
              offset={start}
              total={total}
              pageSize={PAGE_SIZE}
              onOffset={setOffset}
              count={(output.truncated
                ? t("previewMoreRows")
                : output.count > total
                  ? t("previewFirstRows")
                  : "{count}"
              )
                .replace("{count}", output.count.toLocaleString())
                .replace("{shown}", total.toLocaleString())}
            />
          </div>
        </>
      )}
    </div>
  );
}
