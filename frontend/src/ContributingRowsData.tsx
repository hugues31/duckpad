import { useState } from "react";
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
  const body = {
    ...value.query,
    input_dataset: value.input.dataset,
    offset,
    search,
    page_size: 100,
    environment,
  };
  const { data, error, pending } = useResource<PreviewPage>(
    JSON.stringify(body),
    (signal) =>
      api(`/worktrees/${worktree}/lineage/rows`, { ...send(body), signal }),
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
          onChange={(event) => {
            setSearch(event.target.value);
            setOffset(0);
          }}
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
