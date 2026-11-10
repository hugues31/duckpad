import { Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { withQuery } from "./api";
import { useT, useTranslateValue } from "./i18n";
import { projectPageUrl, worktreeUrl } from "./navigation";
import { PageLoading, RouteError } from "./pages/PageStates";
import { DimensionEditor } from "./PartitionDimensionEditor";
import type { PartitionEntry, PartitionPage } from "./partitions";
import { partitionMessage } from "./partitions";
import Select from "./Select";
import type { FlowNode } from "./types";
import { useApiResource } from "./useApiResource";
import { ColumnPicker } from "./ValueSourceFields";
import { useOptionalWorktree } from "./worktree";

/** Selection is inspection only. A request never starts or refreshes a run. */
export function PartitionSelector() {
  const t = useT();
  const worktree = useOptionalWorktree();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const description = worktree?.snapshot?.partitions?.[worktree.environment];
  if (!worktree?.snapshot || !description?.dimension) return null;
  return (
    <div className="partition-selector" ref={root}>
      <button
        ref={trigger}
        className="button secondary small partition-trigger"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="partition-trigger-label">
          {t("partition")}:{" "}
          {description.manifest
            ? worktree.partitionEntry
              ? String(worktree.partitionEntry.key.value)
              : t("partitionAll")
            : t("partitionNotCalculated")}
        </span>
      </button>
      {open && (
        <div className="partition-menu">
          <PartitionStrip onSelect={close} />
          <Link
            className="button secondary small"
            to={projectPageUrl(
              worktree.snapshot.worktree.project,
              "settings/partitions",
              worktree.id,
              worktree.environment,
            )}
          >
            <Settings2 size={14} />
            {t("partitionSettings")}
          </Link>
        </div>
      )}
    </div>
  );
}

export function PartitionStrip({
  node,
  port = "result",
  onSelect,
}: {
  node?: string;
  port?: string;
  onSelect?: () => void;
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
    onSelect?.();
  };
  return (
    <section className="partition-strip" aria-label={t("partitions")}>
      {!description.manifest ? (
        <p>
          {t("partitionNotCalculated")} ·{" "}
          <Link
            to={worktreeUrl(worktree.id, "flow", worktree.environment, {
              node: description.dimension.values.node,
            })}
          >
            {worktree.snapshot?.bundle?.flow.nodes.find(
              (n) => n.id === description.dimension!.values.node,
            )?.label || description.dimension.values.node}
          </Link>
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
            {node &&
              worktree.canEdit &&
              loaded.data?.entries.some(
                (entry) => entry.validity === "failed",
              ) && (
                <button
                  className="button secondary small"
                  disabled={!!worktree.statuses.active || worktree.starting}
                  onClick={() =>
                    worktree.run(undefined, { partitions: { mode: "failed" } })
                  }
                >
                  {t("partitionRunFailed")}
                </button>
              )}
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
                  title={[
                    ...Object.entries(entry.attributes).map(
                      ([key, value]) => `${key}: ${String(value.value)}`,
                    ),
                    state?.error && partitionMessage(t, state.error),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                >
                  <strong>{String(entry.key.value)}</strong> ·{" "}
                  {translate(entry.validity)}
                  {state?.rows != null &&
                    ` · ${state.rows.toLocaleString()} ${t(state.rows === 1 ? "row" : "rows")}`}
                  {state?.duration != null &&
                    ` · ${state.duration.toFixed(2)} s`}
                  {state &&
                    !state.preview_available &&
                    state.validity !== "failed" &&
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

/** Partition definitions belong to the working branch, not instance settings. */
export function PartitionSettings() {
  const worktree = useOptionalWorktree();
  const [version, setVersion] = useState(0);
  if (worktree?.loadError && !worktree.snapshot) return <RouteError />;
  if (!worktree?.snapshot) return <PageLoading />;
  if (!worktree.snapshot.bundle) return <RouteError />;
  return (
    <DimensionEditor
      key={`${worktree.id}:${worktree.environment}:${version}`}
      onSaved={() => setVersion((value) => value + 1)}
    />
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
  const origin =
    info?.origin &&
    (worktree?.snapshot?.bundle?.flow.nodes.find((n) => n.id === info.origin)
      ?.label ||
      info.origin);
  return (
    <section className="partition-inspector">
      <h4>{t("partition")}</h4>
      <p className="muted small">
        {info?.collect?.length
          ? t("partitionCollector")
          : declaration
            ? t("partitionDeclared")
            : info?.partitioned
              ? `${dimension.name} · ${
                  origin
                    ? t("partitionInheritedFrom").replace("{node}", origin)
                    : t("partitionInherited")
                }`
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
          <ColumnPicker
            node={fullNode}
            port={port}
            value={declaration?.column || ""}
            label={t("partitionKeyColumn")}
            disabled={node.partitions === "all"}
            onChange={(column) => {
              const outputs = structuredClone(node.outputs || {});
              outputs[port] = { ...outputs[port] };
              if (column)
                outputs[port].partition = { by: dimension.name, column };
              else delete outputs[port].partition;
              onChange({ ...node, outputs });
            }}
          />
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
