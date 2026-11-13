import { useEffect, useState } from "react";
import { api, send } from "./api";
import DataGrid from "./DataGrid";
import { formatValue } from "./graph";
import { useT } from "./i18n";
import type { Cell, ContributingRows } from "./lineageGraph";
import Pager from "./Pager";
import type { PreviewPage } from "./types";
import { useResource } from "./useApiResource";

export default function ContributingRowsData({
  value,
  worktree,
  environment,
  onClose,
  onExplain,
}: {
  value: ContributingRows;
  worktree: string;
  environment: string;
  onClose: () => void;
  onExplain: (cell: Cell) => void;
}) {
  const t = useT();
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  // Like Data, search once typing pauses.
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      setQuery(search);
      setOffset(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [search, query]);
  const body = {
    ...value.query,
    input_dataset: value.input.dataset,
    offset,
    search: query,
    page_size: 100,
    environment,
  };
  // The current page stays visible while another page or search loads.
  const { data, error, pending } = useResource<PreviewPage>(
    JSON.stringify([value.query, value.input.dataset, environment]),
    (signal) =>
      api(`/worktrees/${worktree}/lineage/rows`, { ...send(body), signal }),
    { refresh: JSON.stringify(body) },
  );
  return (
    <div className="results-data">
      <div className="results-toolbar">
        <strong>{t("lineageContributingRows")}</strong>
        <button className="text-button" onClick={onClose}>
          {t("allRows")}
        </button>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label={t("searchAllColumns")}
          placeholder={t("searchAllColumns")}
        />
      </div>
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      <DataGrid
        columns={data?.columns || []}
        rows={data?.rows || []}
        offset={offset}
        cell={(content, column, row) => (
          <button
            className="cell"
            disabled={pending}
            title={t("explain")}
            aria-label={`${t("explain")}: ${column.name}, ${t("rows")} ${row.id + 1}, ${formatValue(content)}`}
            onClick={() =>
              data &&
              onExplain({
                dataset: data.id,
                node: value.input.node,
                port: value.input.port,
                row: row.id,
                column: column.name,
                partition_context: body.partition_context,
              })
            }
          >
            {formatValue(content)}
          </button>
        )}
      />
      <div className="preview-footer">
        <span>{t("lineageRowsHint")}</span>
        <Pager
          offset={offset}
          total={data?.filtered_count || 0}
          pageSize={100}
          onOffset={setOffset}
        />
      </div>
    </div>
  );
}
