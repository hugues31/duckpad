import { createPortal } from "react-dom";
import { useState } from "react";
import { Settings2 } from "lucide-react";
import { withQuery } from "./api";
import { useT, useTranslateValue } from "./i18n";
import { Modal } from "./modals";
import type {
  PartitionDefinition,
  PartitionEntry,
  PartitionPage,
  PartitionType,
} from "./partitions";
import type { FlowNode } from "./types";
import Select from "./Select";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { useOptionalWorktree } from "./worktree";

/** Selection is inspection only. A request never starts or refreshes a run. */
export function PartitionSelector() {
  const t = useT();
  const worktree = useOptionalWorktree();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const description = worktree?.snapshot?.partitions?.[worktree.environment];
  if (!worktree?.snapshot) return null;
  return (
    <div className="partition-selector">
      <button
        className="button secondary small"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t("partition")}:{" "}
        {description?.dimension
          ? description.manifest
            ? worktree.partitionEntry
              ? String(worktree.partitionEntry.key.value)
              : t("partitionAll")
            : t("partitionNotCalculated")
          : t("partitionNone")}
      </button>
      {open && (
        <div className="partition-menu">
          <PartitionStrip />
          <button
            className="button secondary small"
            onClick={() => {
              setOpen(false);
              setEditing(true);
            }}
          >
            <Settings2 size={14} />
            {t("partitionSettings")}
          </button>
        </div>
      )}
      {editing && createPortal(<DimensionEditor onClose={() => setEditing(false)} />, document.body)}
    </div>
  );
}

export function PartitionStrip({
  node,
  port = "result",
  run,
}: {
  node?: string;
  port?: string;
  run?: string;
}) {
  const t = useT();
  const translate = useTranslateValue();
  const worktree = useOptionalWorktree();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState<string | undefined>();
  const description = worktree?.snapshot?.partitions?.[worktree.environment];
  const endpoint =
    worktree && description?.dimension
      ? withQuery(`/worktrees/${worktree.id}/partitions`, {
          environment: worktree.environment,
          node,
          port,
          search,
          status: status || undefined,
          cursor,
          run,
        })
      : null;
  const loaded = useApiResource<PartitionPage>(endpoint, {
    refresh: JSON.stringify([worktree?.statuses.active, description?.manifest]),
  });
  if (!worktree || !description?.dimension) return null;
  const info = node ? description.nodes[node] : null;
  if (node && !info?.partitioned)
    return (
      <div className="partition-strip muted">
        {info?.collect?.length ? t("partitionCollector") : t("partitionShared")}
      </div>
    );
  const select = (entry: PartitionEntry | null) => {
    worktree.selectPartition(entry);
  };
  return (
    <section className="partition-strip" aria-label={t("partitions")}>
      {!description.manifest ? (
        <p>
          {t("partitionNotCalculated")} ·{" "}
          <code>{description.dimension.values.node}</code>
        </p>
      ) : (
        <>
          <div className="row gap">
            <input
              aria-label={t("partitionSearch")}
              placeholder={t("partitionSearch")}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setCursor(undefined);
              }}
            />
            <Select
              aria-label={t("partitionState")}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setCursor(undefined);
              }}
            >
              <option value="">{t("partitionAllStates")}</option>
              {["valid", "stale", "failed", "missing"].map((value) => (
                <option key={value} value={value}>
                  {translate(value)}
                </option>
              ))}
            </Select>
            <span className="muted small">
              {loaded.data?.total ?? description.manifest.count}{" "}
              {t("partitions")}
            </span>
          </div>
          <div className="partition-segments">
            <button
              className="button secondary small"
              aria-pressed={!worktree.partitionEntry}
              onClick={() => select(null)}
            >
              {t("partitionAll")}
            </button>
            {loaded.data?.entries.map((entry) => {
              const state = node ? entry.nodes[node] : undefined;
              return (
                <button
                  className={`button secondary small partition-segment ${entry.validity}`}
                  key={entry.partition_id}
                  aria-pressed={
                    worktree.partitionEntry?.partition_id === entry.partition_id
                  }
                  onClick={() => select(entry)}
                  title={Object.entries(entry.attributes)
                    .map(([key, value]) => `${key}: ${String(value.value)}`)
                    .join(" · ")}
                >
                  <strong>{String(entry.key.value)}</strong> ·{" "}
                  {translate(entry.validity)}
                  {state?.rows !== undefined &&
                    ` · ${state.rows.toLocaleString()} ${t("rows")}`}
                  {state?.duration !== undefined &&
                    ` · ${state.duration.toFixed(2)} s`}
                  {state &&
                    !state.preview_available &&
                    ` · ${t("partitionNotRetained")}`}
                </button>
              );
            })}
          </div>
          <div className="row gap">
            {cursor && (
              <button
                className="button secondary small"
                onClick={() => setCursor(undefined)}
              >
                {t("partitionFirstPage")}
              </button>
            )}
            {loaded.data?.next_cursor && (
              <button
                className="button secondary small"
                onClick={() => setCursor(loaded.data!.next_cursor!)}
              >
                {t("partitionNextPage")}
              </button>
            )}
          </div>
        </>
      )}
      {loaded.error && (
        <p className="notice error" role="alert">
          {loaded.error}
        </p>
      )}
    </section>
  );
}

function DimensionEditor({ onClose }: { onClose: () => void }) {
  const t = useT();
  const worktree = useOptionalWorktree()!;
  const snapshot = worktree.snapshot!;
  const original = Object.entries(snapshot.bundle?.flow.partitions || {})[0];
  const [name, setName] = useState(original?.[0] || "batch");
  const [draft, setDraft] = useState<PartitionDefinition>(
    original?.[1] || {
      type: "text",
      values: { node: "", port: "result", column: "" },
      attributes: [],
      execution: { parallelism: 1, on_error: "stop" },
      preview: { keep: "last", count: 1, max_bytes: 1073741824 },
    },
  );
  const action = useAsyncAction();
  const [attributes, setAttributes] = useState(
    draft.attributes?.join(", ") || "",
  );
  const save = () =>
    action.run(async () => {
      await worktree.save(snapshot, (bundle) => {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
          throw new Error(t("partitionInvalidName"));
        if (original && original[0] !== name) {
          for (const node of bundle.flow.nodes)
            for (const output of Object.values(node.outputs || {}))
              if (output.partition?.by === original[0])
                output.partition.by = name;
        }
        bundle.flow.partitions = {
          [name]: {
            ...draft,
            attributes: attributes
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          },
        };
      });
      onClose();
    });
  return (
    <Modal title={t("partitionSettings")} onClose={onClose}>
      <div className="modal-content">
        <fieldset disabled={!worktree.canEdit || action.pending}>
          <label className="field">
            <span>{t("partitionDimension")}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>{t("partitionSource")}</span>
            <input
              value={draft.values.node}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  values: { ...draft.values, node: e.target.value },
                })
              }
            />
          </label>
          <label className="field">
            <span>{t("output")}</span>
            <input
              value={draft.values.port || "result"}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  values: { ...draft.values, port: e.target.value },
                })
              }
            />
          </label>
          <label className="field">
            <span>{t("partitionKeyColumn")}</span>
            <input
              value={draft.values.column}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  values: { ...draft.values, column: e.target.value },
                })
              }
            />
          </label>
          <label className="field">
            <span>{t("partitionKeyType")}</span>
            <Select
              value={draft.type}
              onChange={(e) =>
                setDraft({ ...draft, type: e.target.value as PartitionType })
              }
            >
              {["text", "number", "date", "boolean"].map((kind) => (
                <option key={kind}>{kind}</option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span>{t("partitionAttributes")}</span>
            <input
              value={attributes}
              onChange={(e) => setAttributes(e.target.value)}
            />
          </label>
          <label className="field">
            <span>{t("partitionParallelism")}</span>
            <input
              type="number"
              min="1"
              max="32"
              value={draft.execution?.parallelism || 1}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  execution: {
                    ...draft.execution,
                    parallelism: Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label className="field">
            <span>{t("partitionOnError")}</span>
            <Select
              value={draft.execution?.on_error || "stop"}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  execution: {
                    ...draft.execution,
                    on_error: e.target.value as "stop" | "continue",
                  },
                })
              }
            >
              <option value="stop">{t("partitionStop")}</option>
              <option value="continue">{t("partitionContinue")}</option>
            </Select>
          </label>
          <label className="field">
            <span>{t("partitionRetention")}</span>
            <Select
              value={draft.preview?.keep || "last"}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  preview: {
                    max_bytes: draft.preview?.max_bytes,
                    keep: e.target.value as "last" | "all" | "none",
                    ...(e.target.value === "last" ? { count: 1 } : {}),
                  },
                })
              }
            >
              <option value="last">{t("partitionKeepLast")}</option>
              <option value="all">{t("partitionKeepAll")}</option>
              <option value="none">{t("partitionKeepNone")}</option>
            </Select>
          </label>
          <label className="field">
            <span>{t("partitionPreviewBytes")}</span>
            <input
              type="number"
              min="1"
              value={draft.preview?.max_bytes ?? 1073741824}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  preview: {
                    ...draft.preview,
                    max_bytes: Number(e.target.value),
                  },
                })
              }
            />
          </label>
        </fieldset>
        <p className="muted">{t("partitionRetentionHint")}</p>
        {action.error && (
          <p className="notice error" role="alert">
            {action.error}
          </p>
        )}
      </div>
      <footer>
        <button className="button secondary" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className="button primary"
          disabled={!worktree.canEdit || action.pending}
          onClick={save}
        >
          {t("save")}
        </button>
      </footer>
    </Modal>
  );
}

export function PartitionInspector({
  node,
  fullNode,
  ports,
  onChange,
}: {
  node: FlowNode;
  fullNode: string;
  ports: string[];
  onChange: (node: FlowNode) => void;
}) {
  const t = useT();
  const worktree = useOptionalWorktree();
  const [port, setPort] = useState(ports[0] || "result");
  const description = worktree?.snapshot?.partitions?.[worktree.environment];
  const dimension = description?.dimension;
  if (!dimension) return null;
  const declaration = node.outputs?.[port]?.partition;
  const info = description.nodes[fullNode];
  return (
    <section className="partition-inspector">
      <h4>{t("partition")}</h4>
      <p className="muted small">
        {info?.collect?.length
          ? t("partitionCollector")
          : declaration
            ? t("partitionDeclared")
            : info?.partitioned
              ? `${dimension.name} · ${t("partitionInherited")} ${info.origin || ""}`
              : t("partitionShared")}
      </p>
      {!!ports.length && (
        <>
          <label className="field">
            <span>{t("output")}</span>
            <Select value={port} onChange={(e) => setPort(e.target.value)}>
              {ports.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span>{t("partitionKeyColumn")}</span>
            <input
              value={declaration?.column || ""}
              placeholder={t("partitionNoFilter")}
              disabled={node.partitions === "all"}
              onChange={(e) => {
                const outputs = structuredClone(node.outputs || {});
                outputs[port] = { ...outputs[port] };
                if (e.target.value)
                  outputs[port].partition = {
                    by: dimension.name,
                    column: e.target.value,
                  };
                else delete outputs[port].partition;
                onChange({ ...node, outputs });
              }}
            />
          </label>
        </>
      )}
      <label className="row gap">
        <input
          type="checkbox"
          checked={node.partitions === "all"}
          onChange={(e) => {
            const next = structuredClone(node);
            if (e.target.checked) {
              next.partitions = "all";
              for (const output of Object.values(next.outputs || {}))
                delete output.partition;
            } else delete next.partitions;
            onChange(next);
          }}
        />
        {t("partitionCollect")}
      </label>
      {node.partitions === "all" && (
        <p className="muted small">{t("partitionCollectHint")}</p>
      )}
      {info?.error && <p className="notice error">{info.error}</p>}
    </section>
  );
}
