import { useEffect, useState } from "react";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  Filter,
  FlaskConical,
  Loader2,
  Play,
  Plus,
  Search,
  Shuffle,
  SlidersHorizontal,
  Rows3,
  X,
} from "lucide-react";
import { api, ApiError, withQuery } from "./api";
import { formatValue } from "./graph";
import { useT } from "./i18n";
import type { Cell } from "./lineageGraph";
import { Modal } from "./modals";
import {
  appendBlock,
  MAX_SAMPLE_ROWS,
  normalizedSample,
  outputViews,
  sameSample,
  sampleQuery,
  sampleSql,
  storedView,
  suggestedTestName,
  TEST_NAME,
  testBlock,
  usesVariables,
  type Sample,
  type SortDirection,
  type View,
  ALL_ROWS,
} from "./samples";
import {
  detachNode,
  nodeCode,
  nodeCodePath,
  nodeGraph,
  templateUsage,
} from "./nodeCode";
import type { ResultsTarget, SaveProject } from "./ResultsPanel";
import Select from "./Select";
import type {
  Dataset,
  FlowNode,
  Json,
  PreviewPage,
  Snapshot,
  TestRows,
} from "./types";
import { useResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { useStaleVariables } from "./VariableFields";

const PAGE_SIZE = 100;

/** A data test whose failing rows the Data tab shows instead of a sample. */
export interface FailingRows {
  test: string;
  count?: number;
}

/**
 * The rows of a dataset: a sample chosen by the user (first or random rows, a
 * filter and a sort) or shared as a view, or the failing rows of a test.
 */
export default function ResultsData({
  snapshot,
  environment,
  target,
  dataset,
  canEdit,
  active,
  sample,
  view,
  failing,
  tests,
  inspected,
  onSample,
  onFailing,
  onRun,
  onExplain,
  onSave,
  onAddFilter,
  onEditCode,
}: {
  snapshot: Snapshot;
  environment: string;
  target: ResultsTarget;
  dataset?: Dataset;
  canEdit: boolean;
  active: boolean;
  sample: Sample;
  view?: string;
  failing: FailingRows | null;
  tests: string[];
  inspected: { node: FlowNode; parent?: string; fullNode: string };
  onSample: (sample: Sample, view?: string) => void;
  onFailing: (failing: FailingRows | null) => void;
  onRun: () => void;
  onExplain: (cell: Cell) => void;
  onSave: SaveProject;
  onAddFilter: (condition: string) => Promise<unknown>;
  onEditCode: () => void;
}) {
  const t = useT();
  const worktree = snapshot.worktree.id;
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);
  const [dialog, setDialog] = useState<"view" | "test" | null>(null);
  const views = outputViews(
    snapshot.bundle?.views,
    `${target.node}:${target.port}`,
  );
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search, query]);
  const path = failing
    ? withQuery(
        `/worktrees/${worktree}/test-rows/${encodeURIComponent(inspected.fullNode)}/${encodeURIComponent(failing.test)}`,
        { environment, limit: PAGE_SIZE, offset },
      )
    : withQuery(
        `/worktrees/${worktree}/preview/${encodeURIComponent(target.node)}`,
        {
          environment,
          port: target.port,
          limit: PAGE_SIZE,
          offset,
          search: query || undefined,
          ...sampleQuery(sample),
        },
      );
  // The current page stays visible while another page, sample or search loads.
  const { data, error, pending } = useResource<PreviewPage | TestRows | null>(
    `${worktree}:${target.node}:${target.port}`,
    async (signal) => {
      try {
        return await api<PreviewPage | TestRows>(path, { signal });
      } catch (e) {
        if (e instanceof ApiError && e.status === 404 && !failing) return null;
        throw e;
      }
    },
    { refresh: `${path}:${dataset?.id}:${dataset?.status}` },
  );
  const page = data && "status" in data ? data : null;
  const rows = data && "test" in data ? data : null;
  const staleVariables = useStaleVariables(snapshot, environment, page);
  const columns = (page || rows)?.columns || dataset?.columns || [];
  const total = (page || rows)?.filtered_count ?? 0;
  const order = sample.order || [];
  const sortBy = (column: string) => {
    const current =
      order.length === 1 && order[0][0] === column ? order[0][1] : null;
    change({
      ...sample,
      order: [[column, current === "asc" ? "desc" : "asc"]],
    });
  };
  const change = (next: Sample, name?: string) => {
    setOffset(0);
    onSample(normalizedSample(next), name);
  };
  if (!dataset && !page && !failing)
    return (
      <div className="preview-empty">
        <Database size={25} aria-hidden="true" />
        <div>
          <strong>{error || t("noResult")}</strong>
          <p>{t(canEdit ? "noResultHint" : "readerNoResult")}</p>
        </div>
        <button
          className="button secondary small"
          disabled={!canEdit || active}
          onClick={onRun}
        >
          <Play size={13} />
          {t("runNode")}
        </button>
      </div>
    );
  const sampleLabel = sample.rows
    ? t(
        sample.method === "random" ? "sampleRandomRows" : "sampleFirstRows",
      ).replace("{count}", sample.rows.toLocaleString())
    : t("sampleAllRows");
  return (
    <div className="results-data">
      <div className="results-toolbar">
        {failing ? (
          <span className="sample-chip failing">
            <FlaskConical size={12} aria-hidden="true" />
            {t("failingRowsOf").replace("{test}", failing.test)}
            <button
              className="icon"
              title={t("clear")}
              aria-label={t("clear")}
              onClick={() => {
                setOffset(0);
                onFailing(null);
              }}
            >
              <X size={11} />
            </button>
          </span>
        ) : (
          <>
            <div className="sample-anchor">
              <button
                className={`sample-button ${editing ? "active" : ""}`}
                aria-expanded={editing}
                onClick={() => setEditing(!editing)}
              >
                <SlidersHorizontal size={13} aria-hidden="true" />
                {t("sampleLabel").replace("{sample}", sampleLabel)}
              </button>
              {editing && (
                <SamplePopover
                  worktree={worktree}
                  environment={environment}
                  target={target}
                  columns={columns.map((c) => c.name)}
                  sample={sample}
                  canEdit={canEdit}
                  canCreateTest={
                    canEdit && !target.input && !inspected.node.component
                  }
                  onApply={(next) => {
                    change(next);
                    setEditing(false);
                  }}
                  onClose={() => setEditing(false)}
                  onSaveView={(next) => {
                    change(next);
                    setEditing(false);
                    setDialog("view");
                  }}
                  onCreateTest={(next) => {
                    change(next);
                    setEditing(false);
                    setDialog("test");
                  }}
                  onAddFilter={async (condition) => {
                    await onAddFilter(condition);
                    setEditing(false);
                  }}
                />
              )}
            </div>
            {sample.filter && (
              <span className="sample-chip">
                <Filter size={11} aria-hidden="true" />
                <code>{sample.filter}</code>
                <button
                  className="icon"
                  title={t("removeFilter")}
                  aria-label={t("removeFilter")}
                  onClick={() => change({ ...sample, filter: "" })}
                >
                  <X size={11} />
                </button>
              </span>
            )}
            {order.map(([column, direction]) => (
              <span className="sample-chip" key={column}>
                {column} {direction === "desc" ? "↓" : "↑"}
                <button
                  className="icon"
                  title={t("removeSort")}
                  aria-label={`${t("removeSort")}: ${column}`}
                  onClick={() =>
                    change({
                      ...sample,
                      order: order.filter(([name]) => name !== column),
                    })
                  }
                >
                  <X size={11} />
                </button>
              </span>
            ))}
            <span className="spacer" />
            <ViewsBar
              views={views}
              active={view}
              sample={sample}
              canEdit={canEdit}
              onSelect={(item) =>
                change(
                  item,
                  item === ALL_ROWS ? undefined : (item as View).name,
                )
              }
              onSave={() => setDialog("view")}
              onDelete={(name) =>
                onSave((bundle) => {
                  const key = `${target.node}:${target.port}`;
                  const all = bundle.views as Record<string, Json>;
                  const remaining = outputViews(all, key).filter(
                    (item) => item.name !== name,
                  );
                  if (remaining.length) all[key] = remaining as unknown as Json;
                  else delete all[key];
                  if (!Object.keys(all).length) bundle.views = null;
                })
              }
            />
          </>
        )}
        <div className="search results-search">
          <Search size={13} aria-hidden="true" />
          <input
            aria-label={t("searchAllColumns")}
            placeholder={t("searchAllColumns")}
            value={search}
            disabled={!!failing}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="icon"
              title={t("clear")}
              onClick={() => setSearch("")}
            >
              <X size={12} />
            </button>
          )}
        </div>
        {pending && (
          <Loader2 size={14} className="spin" aria-label={t("loading")} />
        )}
      </div>
      {(error || page?.error) && (
        <div className="inline-error" role="alert">
          {error || page?.error}
          {error && !failing && !sameSample(sample, ALL_ROWS) && (
            <button className="text-button" onClick={() => change(ALL_ROWS)}>
              {t("resetSample")}
            </button>
          )}
        </div>
      )}
      {!!staleVariables.length && (
        <div className="stale-reason">{staleVariables.join(" ")}</div>
      )}
      <div className="data-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th className="row-number">#</th>
              {columns.map((column) => {
                const sorted = order.find(
                  ([name]) => name === column.name,
                )?.[1];
                return (
                  <th key={column.name} data-column={column.name}>
                    <button
                      disabled={!!failing}
                      onClick={() => sortBy(column.name)}
                    >
                      <span>
                        {column.name}
                        {sorted ? (sorted === "desc" ? " ↓" : " ↑") : ""}
                      </span>
                      <small>{column.type}</small>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {(page || rows)?.rows.map((row, index) => (
              <tr key={row.id}>
                <td className="row-number">{offset + index + 1}</td>
                {row.values.map((value, i) => (
                  <td key={i}>
                    {page ? (
                      <button
                        className={`cell ${value === null ? "null" : ""}`}
                        disabled={page.status !== "valid" || active}
                        title={
                          page.status === "valid"
                            ? t("explain")
                            : t("staleHint")
                        }
                        aria-label={`${t("explain")}: ${columns[i].name}, ${t("rows")} ${row.id + 1}, ${formatValue(value)}`}
                        onClick={() =>
                          onExplain({
                            dataset: page.id,
                            row: row.id,
                            column: columns[i].name,
                          })
                        }
                      >
                        {formatValue(value)}
                      </button>
                    ) : (
                      <span
                        className={`cell-text ${value === null ? "null" : ""}`}
                      >
                        {formatValue(value)}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.rows.length && (
          <p className="empty-small">{t("noMatches")}</p>
        )}
      </div>
      <div className="preview-footer">
        <span title={page?.created}>
          {failing
            ? t("failingRowsHint")
            : page && (sample.filter || query)
              ? t("sampleMatches")
                  .replace(
                    "{matched}",
                    (page.matched_count ?? total).toLocaleString(),
                  )
                  .replace("{count}", page.count.toLocaleString())
              : page?.status === "stale"
                ? t("staleHint")
                : t("snapshotHint")}
        </span>
        <div className="row">
          <span>
            {total
              ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)}`
              : "0"}{" "}
            / {total.toLocaleString()}
          </span>
          <button
            className="icon"
            disabled={!offset}
            title={t("previous")}
            aria-label={t("previous")}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            className="icon"
            disabled={offset + PAGE_SIZE >= total}
            title={t("next")}
            aria-label={t("next")}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      {dialog === "view" && (
        <SaveViewModal
          views={views}
          sample={sample}
          onClose={() => setDialog(null)}
          onSave={async (name) => {
            await onSave((bundle) => {
              const key = `${target.node}:${target.port}`;
              if (typeof bundle.views === "string")
                throw new Error(t("invalidViewsFile"));
              const all = (bundle.views ||= {}) as Record<string, Json>;
              const list = outputViews(all, key).filter(
                (item) => item.name !== name,
              );
              all[key] = [...list, storedView(name, sample)] as unknown as Json;
            });
            onSample(sample, name);
          }}
        />
      )}
      {dialog === "test" && (
        <CreateTestModal
          snapshot={snapshot}
          node={inspected.node}
          parent={inspected.parent}
          port={target.port}
          filter={sample.filter || ""}
          tests={tests}
          onClose={() => setDialog(null)}
          onSave={onSave}
          onEditCode={onEditCode}
        />
      )}
    </div>
  );
}

function ViewsBar({
  views,
  active,
  sample,
  canEdit,
  onSelect,
  onSave,
  onDelete,
}: {
  views: View[];
  active?: string;
  sample: Sample;
  canEdit: boolean;
  onSelect: (sample: Sample) => void;
  onSave: () => void;
  onDelete: (name: string) => Promise<unknown>;
}) {
  const t = useT();
  const remove = useAsyncAction();
  const current = views.find((item) => item.name === active);
  const allRows = !current && sameSample(sample, ALL_ROWS);
  return (
    <div className="views-bar" role="group" aria-label={t("sharedViews")}>
      <button
        className={`view-chip ${allRows ? "active" : ""}`}
        aria-pressed={allRows}
        onClick={() => onSelect(ALL_ROWS)}
      >
        {t("allRows")}
      </button>
      {views.map((item) => {
        const selected =
          current?.name === item.name && sameSample(item, sample);
        return (
          <span
            key={item.name}
            className={`view-chip ${selected ? "active" : ""}`}
          >
            <button
              aria-pressed={selected}
              onClick={() => onSelect(item)}
              title={item.filter || item.name}
            >
              <Bookmark size={11} aria-hidden="true" />
              {item.name}
            </button>
            {canEdit && (
              <button
                className="icon"
                title={t("deleteView")}
                aria-label={`${t("deleteView")}: ${item.name}`}
                disabled={remove.pending}
                onClick={() => remove.run(() => onDelete(item.name))}
              >
                <X size={10} />
              </button>
            )}
          </span>
        );
      })}
      {canEdit && !allRows && !(current && sameSample(current, sample)) && (
        <button className="text-button" onClick={onSave}>
          <Plus size={12} aria-hidden="true" />
          {t("saveView")}
        </button>
      )}
      {remove.error && (
        <span className="notice error small">{remove.error}</span>
      )}
    </div>
  );
}

function SamplePopover({
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
  const [checked, setChecked] = useState(draft.filter || "");
  const copy = useAsyncAction();
  const insert = useAsyncAction();
  const [copied, setCopied] = useState(false);
  const filter = draft.filter || "";
  useEffect(() => {
    if (filter === checked) return;
    const timer = setTimeout(() => setChecked(filter), 400);
    return () => clearTimeout(timer);
  }, [filter, checked]);
  // The number of matching rows, counted on the whole dataset as the filter is typed.
  const matches = useResource<PreviewPage>(
    checked.trim() ? `${target.node}:${target.port}:${checked}` : null,
    (signal) =>
      api<PreviewPage>(
        withQuery(
          `/worktrees/${worktree}/preview/${encodeURIComponent(target.node)}`,
          {
            environment,
            port: target.port,
            limit: 1,
            filter: checked,
          },
        ),
        { signal },
      ),
  );
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
          ) : matches.data && checked === filter ? (
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

function SaveViewModal({
  views,
  sample,
  onSave,
  onClose,
}: {
  views: View[];
  sample: Sample;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(sample.filter?.slice(0, 60) || "");
  const { pending, error, run } = useAsyncAction();
  const replaces = views.some((view) => view.name === name.trim());
  return (
    <Modal title={t("saveViewTitle")} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await run(() => onSave(name.trim()))) onClose();
        }}
      >
        <div className="modal-content">
          <p className="muted">{t("saveViewHint")}</p>
          <label className="field">
            <span>{t("viewName")}</span>
            <input
              autoFocus
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {replaces && <p className="muted small">{t("viewReplaced")}</p>}
          <pre className="expression">{sampleSql("output", sample)}</pre>
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="button primary" disabled={pending || !name.trim()}>
            {pending ? t("saving") : t("saveView")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

function CreateTestModal({
  snapshot,
  node,
  parent,
  port,
  filter,
  tests,
  onSave,
  onClose,
  onEditCode,
}: {
  snapshot: Snapshot;
  node: FlowNode;
  parent?: string;
  port: string;
  filter: string;
  tests: string[];
  onSave: SaveProject;
  onClose: () => void;
  onEditCode: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(() => suggestedTestName(filter));
  const [severity, setSeverity] = useState<"warning" | "error">("warning");
  const [detach, setDetach] = useState(false);
  const { pending, error, run } = useAsyncAction();
  const linked = node.template
    ? templateUsage(snapshot.bundle!, node.template)
    : 0;
  const invalid = !TEST_NAME.test(name)
    ? t("testNameInvalid")
    : tests.includes(name)
      ? t("testNameTaken")
      : "";
  const block = testBlock(name, severity, port, filter);
  return (
    <Modal title={t("createTestTitle")} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const done = await run(() =>
            onSave((bundle) => {
              const graph = nodeGraph(bundle, parent);
              const current = graph.nodes.find((item) => item.id === node.id);
              if (!current) throw new Error(t("nodeRemoved"));
              if (current.template && detach)
                detachNode(bundle, current, parent);
              if (current.template)
                bundle.templates[current.template] = appendBlock(
                  bundle.templates[current.template],
                  block,
                );
              else
                (bundle.node_sql ||= {})[nodeCodePath(current.id, parent)] =
                  appendBlock(nodeCode(bundle, current, parent), block);
            }),
          );
          if (done) onClose();
        }}
      >
        <div className="modal-content">
          <p className="muted">{t("createTestHint")}</p>
          <label className="field">
            <span>{t("testName")}</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("testSeverity")}</span>
            <Select
              aria-label={t("testSeverity")}
              value={severity}
              onChange={(e) =>
                setSeverity(e.target.value as "warning" | "error")
              }
            >
              <option value="warning">{t("messageWarning")}</option>
              <option value="error">{t("messageError")}</option>
            </Select>
          </label>
          <pre className="expression">{block}</pre>
          {node.template && (
            <div className="notice">
              <p>
                {t(
                  linked === 1 ? "testTemplateOne" : "testTemplateCount",
                ).replace("{count}", String(linked))}
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={detach}
                  onChange={(e) => setDetach(e.target.checked)}
                />
                {t("testDetachFirst")}
              </label>
            </div>
          )}
          {invalid && name && <p className="notice error small">{invalid}</p>}
          {error && (
            <div className="notice error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="text-button" onClick={onEditCode}>
            {t("editNodeCode")}
          </button>
          <span className="spacer" />
          <button type="button" className="button secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="button primary" disabled={pending || !!invalid}>
            {pending ? t("saving") : t("createTest")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
