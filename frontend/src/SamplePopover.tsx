import {
  Bookmark,
  Copy,
  Filter,
  FlaskConical,
  Plus,
  Rows3,
  Shuffle,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useState } from "react";
import { useT } from "./i18n";
import type { ResultsTarget } from "./results";
import {
  ALL_ROWS,
  MAX_SAMPLE_ROWS,
  normalizedSample,
  sameSample,
  sampleSql,
  usesVariables,
  type Sample,
  type SortDirection,
} from "./samples";
import Select from "./Select";
import { useAsyncAction } from "./useAsyncAction";
import { useFilterMatchCount } from "./useFilterMatchCount";

export function SamplePopover({
  worktree,
  environment,
  target,
  columns,
  sample,
  canEdit,
  canCreateTest,
  onApply,
  onClose,
  onSaveView,
  onCreateTest,
  onAddFilter,
}: {
  worktree: string;
  environment: string;
  target: ResultsTarget;
  columns: string[];
  sample: Sample;
  canEdit: boolean;
  canCreateTest: boolean;
  onApply: (sample: Sample) => void;
  onClose: () => void;
  onSaveView: (sample: Sample) => void;
  onCreateTest: (sample: Sample) => void;
  onAddFilter: (condition: string) => Promise<void>;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Sample>({
    ...sample,
    rows: sample.rows,
    order: sample.order || [],
  });
  const copy = useAsyncAction();
  const insert = useAsyncAction();
  const [copied, setCopied] = useState(false);
  const filter = draft.filter || "";
  const matches = useFilterMatchCount(worktree, environment, target, filter);
  const order = draft.order || [];
  const setOrder = (next: [string, SortDirection][]) =>
    setDraft({ ...draft, order: next });
  const rowsValid =
    !draft.rows || (draft.rows >= 1 && draft.rows <= MAX_SAMPLE_ROWS);
  const filterVariables = usesVariables(filter);
  return (
    <div
      className="sample-popover"
      role="dialog"
      aria-label={t("sample")}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header>
        <SlidersHorizontal size={14} aria-hidden="true" />
        <strong>{t("sample")}</strong>
        <span className="muted small">
          {target.input ? `${target.input} ←` : target.port}
        </span>
        <button
          className="icon"
          title={t("close")}
          aria-label={t("close")}
          onClick={onClose}
        >
          <X size={15} />
        </button>
      </header>
      <section>
        <h5>{t("sampleRows")}</h5>
        <div className="row gap">
          <div className="segmented">
            <button
              className={draft.method === "first" ? "active" : ""}
              aria-pressed={draft.method === "first"}
              onClick={() => setDraft({ ...draft, method: "first" })}
            >
              <Rows3 size={12} aria-hidden="true" />
              {t("firstRows")}
            </button>
            <button
              className={draft.method === "random" ? "active" : ""}
              aria-pressed={draft.method === "random"}
              onClick={() =>
                setDraft({
                  ...draft,
                  method: "random",
                  rows: draft.rows || 100,
                  seed: draft.seed ?? Math.floor(Math.random() * 1000),
                })
              }
            >
              <Shuffle size={12} aria-hidden="true" />
              {t("randomRows")}
            </button>
          </div>
          <input
            type="number"
            min={1}
            max={MAX_SAMPLE_ROWS}
            aria-label={t("sampleSize")}
            placeholder={t("allRowsPlaceholder")}
            value={draft.rows ?? ""}
            onChange={(e) =>
              setDraft({
                ...draft,
                rows: e.target.value ? Number(e.target.value) : undefined,
              })
            }
          />
          {draft.method === "random" && (
            <label className="seed">
              {t("seed")}
              <input
                type="number"
                min={0}
                aria-label={t("seed")}
                value={draft.seed ?? 0}
                onChange={(e) =>
                  setDraft({ ...draft, seed: Number(e.target.value) || 0 })
                }
              />
            </label>
          )}
          <small className="muted">{t("sampleSizeHint")}</small>
        </div>
      </section>
      <section>
        <h5>
          {t("sampleFilter")}{" "}
          <small className="muted">{t("sampleFilterHint")}</small>
        </h5>
        <textarea
          aria-label={t("sampleFilter")}
          spellCheck={false}
          value={filter}
          placeholder="channel = 'Partner' AND amount > 300"
          onChange={(e) => setDraft({ ...draft, filter: e.target.value })}
        />
        <p className="sample-check small" role="status">
          {!filter.trim() ? (
            t("sampleFilterVariables")
          ) : matches.error ? (
            <span className="error-text">{matches.error}</span>
          ) : matches.data && !matches.pending ? (
            t("matchingRows").replace(
              "{count}",
              (
                matches.data.matched_count ?? matches.data.filtered_count
              ).toLocaleString(),
            )
          ) : (
            t("loading")
          )}
        </p>
      </section>
      <section>
        <h5>{t("sampleSort")}</h5>
        {order.map(([column, direction], index) => (
          <div className="row gap sort-row" key={index}>
            <Select
              aria-label={t("sortColumn")}
              value={column}
              onChange={(e) =>
                setOrder(
                  order.map((item, i) =>
                    i === index ? [e.target.value, item[1]] : item,
                  ),
                )
              }
            >
              {columns
                .filter(
                  (name) =>
                    name === column || !order.some(([used]) => used === name),
                )
                .map((name) => (
                  <option key={name}>{name}</option>
                ))}
            </Select>
            <Select
              aria-label={t("sortDirection")}
              value={direction}
              onChange={(e) =>
                setOrder(
                  order.map((item, i) =>
                    i === index
                      ? [item[0], e.target.value as SortDirection]
                      : item,
                  ),
                )
              }
            >
              <option value="asc">{t("ascending")}</option>
              <option value="desc">{t("descending")}</option>
            </Select>
            <button
              className="icon"
              title={t("removeSort")}
              aria-label={`${t("removeSort")}: ${column}`}
              onClick={() => setOrder(order.filter((_, i) => i !== index))}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {order.length < columns.length && (
          <button
            className="text-button"
            onClick={() => {
              const next = columns.find(
                (name) => !order.some(([used]) => used === name),
              );
              if (next) setOrder([...order, [next, "asc"]]);
            }}
          >
            <Plus size={12} aria-hidden="true" />
            {t("sortColumnAdd")}
          </button>
        )}
      </section>
      <section className="sample-bridges">
        {canEdit && !target.input && (
          <button
            className="text-button"
            disabled={!filter.trim() || insert.pending}
            onClick={() => insert.run(() => onAddFilter(filter.trim()))}
          >
            <Filter size={12} aria-hidden="true" />
            {t("addFilterNode")}
          </button>
        )}
        {canCreateTest && (
          <button
            className="text-button"
            disabled={!filter.trim() || filterVariables}
            title={filterVariables ? t("testVariablesHint") : undefined}
            onClick={() => onCreateTest(normalizedSample(draft))}
          >
            <FlaskConical size={12} aria-hidden="true" />
            {t("createTestFromFilter")}
          </button>
        )}
        <button
          className="text-button"
          onClick={() =>
            copy.run(async () => {
              await navigator.clipboard.writeText(
                sampleSql(target.port, normalizedSample(draft)),
              );
              setCopied(true);
            })
          }
        >
          <Copy size={12} aria-hidden="true" />
          {copied ? t("copiedSql") : t("copySql")}
        </button>
        {(copy.error || insert.error) && (
          <p className="notice error small">{copy.error || insert.error}</p>
        )}
      </section>
      <footer>
        <button className="text-button" onClick={() => setDraft(ALL_ROWS)}>
          {t("resetSample")}
        </button>
        <span className="spacer" />
        {canEdit && (
          <button
            className="button secondary small"
            disabled={!rowsValid || sameSample(draft, ALL_ROWS)}
            onClick={() => onSaveView(normalizedSample(draft))}
          >
            <Bookmark size={12} aria-hidden="true" />
            {t("saveViewEllipsis")}
          </button>
        )}
        <button
          className="button primary small"
          disabled={!rowsValid}
          onClick={() => onApply(normalizedSample(draft))}
        >
          {t("apply")}
        </button>
      </footer>
    </div>
  );
}
