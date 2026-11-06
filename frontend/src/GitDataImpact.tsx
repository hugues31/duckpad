import { useState } from "react";
import { api, send, withQuery } from "./api";
import { TabStatus } from "./gitTabs";
import type { MergeReview } from "./gitTypes";
import { useT } from "./i18n";
import Select from "./Select";
import type { Dataset } from "./types";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";

interface ResultPair {
  node: string;
  name: string;
  port: string;
  before: Dataset;
  after: Dataset;
  keys: string[];
  columns: {
    added: string[];
    removed: string[];
    retyped: { name: string; before: string; after: string }[];
  };
}
interface RowChanges {
  added: number;
  removed: number;
  modified: number | null;
}

function OutputImpact({
  pair,
  base,
  environment,
}: {
  pair: ResultPair;
  base: string;
  environment: string;
}) {
  const t = useT();
  const [key, setKey] = useState("");
  const [changes, setChanges] = useState<RowChanges | null>(null);
  const { pending, error, run, setError } = useAsyncAction();
  const calculate = () =>
    void run(async () => {
      setChanges(null);
      setChanges(
        await api<RowChanges>(
          base,
          send({
            environment,
            node: pair.node,
            port: pair.port,
            before: pair.before.id,
            after: pair.after.id,
            key: key || null,
          }),
        ),
      );
    });
  return (
    <section className="git-data-output">
      <h4>
        {pair.name} · {pair.port}
      </h4>
      <p>
        {pair.before.count.toLocaleString()} →{" "}
        {pair.after.count.toLocaleString()} {t("rows")}
      </p>
      <p>
        {t("gitColumnsAdded")}: {pair.columns.added.join(", ") || "—"} ·{" "}
        {t("gitColumnsRemoved")}: {pair.columns.removed.join(", ") || "—"}
      </p>
      {pair.columns.retyped.map((column) => (
        <p key={column.name}>
          {column.name}: {column.before} → {column.after}
        </p>
      ))}
      <div className="git-controls">
        <label>
          {t("gitComparisonKey")}{" "}
          <Select
            value={key}
            disabled={pending}
            onChange={(e) => {
              setKey(e.target.value);
              setChanges(null);
              setError("");
            }}
          >
            <option value="">{t("gitNoKey")}</option>
            {pair.keys.map((column) => (
              <option key={column}>{column}</option>
            ))}
          </Select>
        </label>
        <button
          className="button secondary small"
          disabled={pending}
          onClick={calculate}
        >
          {t("gitComputeImpact")}
        </button>
      </div>
      <TabStatus pending={pending} error={error} onRetry={calculate} />
      {changes && (
        <p role="status">
          {t("gitRowsAdded")}: {changes.added} · {t("gitRowsRemoved")}:{" "}
          {changes.removed}
          {changes.modified !== null && (
            <>
              {" "}
              · {t("gitRowsModified")}: {changes.modified}
            </>
          )}
        </p>
      )}
    </section>
  );
}

export default function GitDataImpact({
  review,
  environment,
}: {
  review: MergeReview;
  environment: string;
}) {
  const t = useT();
  const base = `/worktrees/${review.worktree}/git/reviews/${review.id}/data`;
  const { data, error, pending, reload } = useApiResource<ResultPair[]>(
    withQuery(base, { environment }),
  );
  return (
    <section className="git-data-impact" aria-label={t("gitDataImpact")}>
      <h3>
        {t("gitDataImpact")} · {environment}
      </h3>
      <p className="muted">
        {t("gitDataImpactHint")
          .replace("{source}", review.source)
          .replace("{destination}", review.destination)}
      </p>
      <TabStatus error={error} pending={pending} onRetry={reload} />
      {data?.length === 0 && <p>{t("gitNoComparableResults")}</p>}
      {data?.map((pair) => (
        <OutputImpact
          key={`${environment}:${pair.node}:${pair.port}:${pair.before.id}:${pair.after.id}`}
          pair={pair}
          base={base}
          environment={environment}
        />
      ))}
      <details>
        <summary>{t("gitDetails")}</summary>
        <p>{t("gitDataImpactMethod")}</p>
      </details>
      <button
        className="button secondary small"
        disabled={pending}
        onClick={reload}
      >
        {t("reloadState")}
      </button>
    </section>
  );
}
