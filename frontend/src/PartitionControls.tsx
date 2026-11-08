import { ColumnPicker, ValueSourceFields } from "./ValueSourceFields";
import { useEffect, useMemo, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { Link } from "react-router";
import { withQuery } from "./api";
import { useT, useTranslateValue } from "./i18n";
import { useRevisionDraft } from "./useRevisionDraft";
import { projectPageUrl } from "./navigation";
import { PageLoading, RouteError } from "./pages/PageStates";
import type {
  PartitionDefinition,
  PartitionEntry,
  PartitionPage,
  PartitionType,
} from "./partitions";
import type { FlowNode } from "./types";
import { partitionMessage, renamePartitionReferences } from "./partitions";
import Select from "./Select";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
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
            to={`/worktrees/${worktree.id}/flow?${new URLSearchParams({ environment: worktree.environment, node: description.dimension.values.node })}`}
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

function DimensionEditor({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const translate = useTranslateValue();
  const worktree = useOptionalWorktree()!;
  const snapshot = worktree.snapshot!;
  const original = Object.entries(snapshot.bundle!.flow.partitions || {})[0];
  const value = useMemo(() => {
    const original = Object.entries(snapshot.bundle!.flow.partitions || {})[0];
    const definition: PartitionDefinition = original?.[1] || {
      type: "text",
      values: { node: "", column: "" },
      attributes: [],
      execution: { parallelism: 1, on_error: "stop" },
      preview: { keep: "last", count: 1, max_bytes: 1073741824 },
    };
    return {
      name: original?.[0] || "batch",
      definition,
      attributes: definition.attributes?.join(", ") || "",
      renames: {} as Record<string, string>,
    };
  }, [snapshot.bundle]);
  const action = useAsyncAction();
  const editor = useRevisionDraft(
    value,
    snapshot,
    async ({ name, definition: draft, attributes, renames }, base) => {
      const original = Object.entries(base.bundle!.flow.partitions || {})[0];
      return worktree.save(base, (bundle) => {
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
          throw new Error(t("partitionInvalidName"));
        const nextAttributes = attributes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((value) => renames[value] ?? value);
        if (
          nextAttributes.some(
            (value) => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value),
          ) ||
          new Set(nextAttributes).size !== nextAttributes.length
        )
          throw new Error(t("partitionInvalidName"));
        for (const node of bundle.flow.nodes) {
          node.params = renamePartitionReferences(
            node.params || {},
            renames,
          ) as FlowNode["params"];
          for (const attribute of original?.[1].attributes || []) {
            const current = renames[attribute] ?? attribute;
            if (nextAttributes.includes(current)) continue;
            if (
              JSON.stringify(
                renamePartitionReferences(node.params || {}, {
                  [current]: "__removed_partition_attribute",
                }),
              ) !== JSON.stringify(node.params || {})
            )
              throw new Error(t("partitionAttributeUsed"));
          }
        }
        if (original && original[0] !== name) {
          for (const node of bundle.flow.nodes)
            for (const output of Object.values(node.outputs || {}))
              if (output.partition?.by === original[0])
                output.partition.by = name;
        }
        bundle.flow.partitions = {
          [name]: {
            ...draft,
            attributes: nextAttributes,
          },
        };
      });
    },
    { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  const { name, definition: draft, attributes, renames } = editor.draft;
  const setName = (name: string) =>
    editor.update((value) => ({ ...value, name }));
  const setDraft = (definition: PartitionDefinition) =>
    editor.update((value) => ({ ...value, definition }));
  const setAttributes = (attributes: string) =>
    editor.update((value) => ({ ...value, attributes }));
  const setRenames = (renames: Record<string, string>) =>
    editor.update((value) => ({ ...value, renames }));
  return (
    <form
      className="settings-card partition-settings"
      aria-label={t("partitionSettings")}
      onSubmit={(event) => {
        event.preventDefault();
        void action.run(async () => {
          await editor.persist();
          onSaved();
        });
      }}
    >
      <h2>{t("partitions")}</h2>
      <p className="muted">{t("partitionSettingsHint")}</p>
      <p>
        {t("branch")}: <strong>{snapshot.worktree.branch}</strong>
      </p>
      <fieldset
        className="settings-fields"
        disabled={!worktree.canEdit || action.pending}
      >
        <label className="field">
          <span>{t("partitionDimension")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <ValueSourceFields
          snapshot={snapshot}
          value={draft.values}
          onChange={(values) => setDraft({ ...draft, values })}
        />
        <label className="field">
          <span>{t("partitionKeyType")}</span>
          <Select
            value={draft.type}
            onChange={(e) =>
              setDraft({ ...draft, type: e.target.value as PartitionType })
            }
          >
            {["text", "number", "date", "boolean"].map((kind) => (
              <option key={kind} value={kind}>
                {translate(kind)}
              </option>
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
        {(editor.saved.definition.attributes || []).map((attribute) => (
          <label className="field" key={attribute}>
            <span>
              {t("partitionRenameAttribute").replace("{name}", attribute)}
            </span>
            <input
              value={renames[attribute] ?? attribute}
              onChange={(event) =>
                setRenames({ ...renames, [attribute]: event.target.value })
              }
            />
          </label>
        ))}
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
            step="1"
            value={(draft.preview?.max_bytes ?? 1073741824) / 1048576}
            onChange={(e) =>
              setDraft({
                ...draft,
                preview: {
                  ...draft.preview,
                  max_bytes: Math.round(Number(e.target.value) * 1048576),
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
      <div className="partition-settings-actions row gap">
        {original && (
          <button
            type="button"
            className="button secondary"
            disabled={
              !worktree.canEdit ||
              action.pending ||
              snapshot.bundle!.flow.nodes.some(
                (node) =>
                  node.partitions === "all" ||
                  Object.values(node.outputs || {}).some(
                    (output) => output.partition,
                  ),
              )
            }
            onClick={() =>
              action.run(async () => {
                await worktree.save(snapshot, (bundle) => {
                  delete bundle.flow.partitions;
                });
                editor.discard();
                onSaved();
              })
            }
          >
            {t("partitionRemoveDimension")}
          </button>
        )}
        <button
          type="button"
          className="button secondary"
          disabled={!editor.dirty || action.pending}
          onClick={() => {
            editor.discard();
            action.setError("");
          }}
        >
          {t("discardChanges")}
        </button>
        <button
          className="button primary"
          disabled={
            !worktree.canEdit ||
            action.pending ||
            !editor.dirty ||
            !draft.values.node ||
            !draft.values.column.trim()
          }
        >
          {t("save")}
        </button>
        {editor.dirty && (
          <span className="muted small">{t("unsavedChanges")}</span>
        )}
      </div>
    </form>
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
