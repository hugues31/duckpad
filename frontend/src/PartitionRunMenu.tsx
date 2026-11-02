import { createPortal } from "react-dom";
import { useState } from "react";
import { withQuery } from "./api";
import { useT } from "./i18n";
import { Modal } from "./modals";
import type {
  PartitionEntry,
  PartitionLaunchOptions,
  PartitionPage,
} from "./partitions";
import Select from "./Select";
import { useApiResource } from "./useApiResource";
import { useOptionalWorktree } from "./worktree";

export function PartitionRunSummary({
  options,
  node,
}: {
  options?: PartitionLaunchOptions;
  node?: string;
}) {
  const t = useT();
  const worktree = useOptionalWorktree();
  const description = worktree?.snapshot?.partitions?.[worktree.environment];
  if (!description?.dimension) return null;
  const policy = {
    ...description.dimension.execution,
    ...options?.partition_execution,
  };
  return (
    <div className="partition-strip">
      <p>
        {t(node ? "partitionRetainedLaunch" : "partitionFreshLaunch")} ·{" "}
        <code>{description.dimension.values.node}</code>
      </p>
      <p>
        {t("partitionParallelism")}: {policy.parallelism || 1} ·{" "}
        {t("partitionOnError")}:{" "}
        {t(
          policy.on_error === "continue"
            ? "partitionContinue"
            : "partitionStop",
        )}
      </p>
      <p>
        {t("partitionSelection")}: {options?.partitions?.mode || "all"}
        {options?.partitions?.keys
          ?.map((key) => ` · ${String(key.value)}`)
          .join("")}
      </p>
      <p className="muted">
        {t("partitionStorageEstimate").replace(
          "{count}",
          String(description.manifest?.count ?? "?"),
        )}
      </p>
      <p className="muted">{t("partitionExportNotice")}</p>
    </div>
  );
}

export function PartitionRunMenu() {
  const t = useT();
  const worktree = useOptionalWorktree();
  const [open, setOpen] = useState(false);
  if (!worktree?.snapshot?.partitions?.[worktree.environment]?.dimension)
    return null;
  return (
    <>
      <button
        className="button secondary small"
        disabled={!worktree.canEdit || worktree.starting}
        onClick={() => setOpen(true)}
      >
        {t("partitionRunOptions")}
      </button>
      {open &&
        createPortal(
          <RunOptions onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}

function RunOptions({ onClose }: { onClose: () => void }) {
  const t = useT();
  const worktree = useOptionalWorktree()!;
  const defaults =
    worktree.snapshot!.partitions![worktree.environment].dimension!.execution;
  const [mode, setMode] = useState<"all" | "failed" | "missing" | "selected">(
    "all",
  );
  const [parallelism, setParallelism] = useState(defaults?.parallelism || 1);
  const [onError, setOnError] = useState<"stop" | "continue">(
    defaults?.on_error || "stop",
  );
  const [selected, setSelected] = useState<PartitionEntry["key"][]>(
    worktree.partitionEntry ? [worktree.partitionEntry.key] : [],
  );
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const page = useApiResource<PartitionPage>(
    mode === "selected"
      ? withQuery(`/worktrees/${worktree.id}/partitions`, {
          environment: worktree.environment,
          search,
          cursor,
        })
      : null,
  );
  const options: PartitionLaunchOptions = {
    partitions: {
      mode,
      ...(mode === "selected"
        ? { keys: selected.map(({ type, value }) => ({ type, value })) }
        : {}),
    },
    partition_execution: { parallelism, on_error: onError },
  };
  return (
    <Modal title={t("partitionRunOptions")} onClose={onClose}>
      <div className="modal-content">
        <label className="field">
          <span>{t("partitionSelection")}</span>
          <Select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
          >
            <option value="all">{t("partitionAll")}</option>
            <option value="failed">{t("partitionRunFailed")}</option>
            <option value="missing">{t("partitionRunMissing")}</option>
            <option value="selected">{t("partitionRunSelected")}</option>
          </Select>
        </label>
        {mode === "selected" && (
          <section>
            <input
              aria-label={t("partitionSearch")}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCursor(undefined);
              }}
            />
            <div className="partition-segments">
              {page.data?.entries.map((entry) => {
                const chosen = selected.some(
                  (key) =>
                    key.type === entry.key.type &&
                    key.value === entry.key.value,
                );
                return (
                  <label className="row gap" key={entry.partition_id}>
                    <input
                      type="checkbox"
                      checked={chosen}
                      onChange={() =>
                        setSelected(
                          chosen
                            ? selected.filter(
                                (key) =>
                                  key.type !== entry.key.type ||
                                  key.value !== entry.key.value,
                              )
                            : [
                                ...selected,
                                {
                                  type: entry.key.type,
                                  value: entry.key.value,
                                },
                              ],
                        )
                      }
                    />
                    {String(entry.key.value)}
                  </label>
                );
              })}
            </div>
            {page.data?.next_cursor && (
              <button
                className="button secondary small"
                onClick={() => setCursor(page.data!.next_cursor!)}
              >
                {t("partitionNextPage")}
              </button>
            )}
            {page.error && <p role="alert">{page.error}</p>}
          </section>
        )}
        <label className="field">
          <span>{t("partitionParallelism")}</span>
          <input
            type="number"
            min="1"
            value={parallelism}
            onChange={(e) => setParallelism(Number(e.target.value))}
          />
        </label>
        <label className="field">
          <span>{t("partitionOnError")}</span>
          <Select
            value={onError}
            onChange={(e) => setOnError(e.target.value as typeof onError)}
          >
            <option value="stop">{t("partitionStop")}</option>
            <option value="continue">{t("partitionContinue")}</option>
          </Select>
        </label>
        <PartitionRunSummary options={options} />
      </div>
      <footer>
        <button className="button secondary" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className="button primary"
          disabled={
            worktree.starting ||
            parallelism < 1 ||
            !Number.isInteger(parallelism) ||
            (mode === "selected" && !selected.length)
          }
          onClick={() => {
            onClose();
            void worktree.run(undefined, options);
          }}
        >
          {t("run")}
        </button>
      </footer>
    </Modal>
  );
}
