import { withQuery } from "./api";
import { useApiResource } from "./useApiResource";
import { nodeInterface, outputSource } from "./graph";
import { localDefinitions } from "./nodeCode";
import { templateLabel, useT } from "./i18n";
import Select from "./Select";
import type { PreviewPage, Snapshot } from "./types";
import { useOptionalWorktree } from "./worktree";

export type ValueSource = { node: string; port?: string; column: string };

/** Shared computed-value and partition source descriptor editor. */
export function ValueSourceFields({
  snapshot,
  value,
  onChange,
}: {
  snapshot: Snapshot;
  value: ValueSource;
  onChange: (value: ValueSource) => void;
}) {
  const t = useT();
  const nodes = snapshot.bundle?.flow.nodes || [];
  const outputs = (node: (typeof nodes)[number]) =>
    nodeInterface(
      node,
      snapshot.parsed_templates,
      snapshot.bundle?.components,
      localDefinitions(snapshot),
    ).outputs;
  const sources = nodes.filter((node) => outputs(node).length);
  const source = nodes.find((node) => node.id === value.node);
  const ports = source ? outputs(source) : [];
  const set = (change: Partial<ValueSource>) => {
    const { node, port, column } = { ...value, ...change };
    onChange({ node, ...(port ? { port } : {}), column });
  };
  return (
    <>
      <label className="field">
        <span>{t("valueSourceNode")}</span>
        <Select
          aria-label={t("valueSourceNode")}
          value={value.node}
          onChange={(e) =>
            set({ node: e.target.value, port: undefined, column: "" })
          }
        >
          <option value="">{t("chooseValueSource")}</option>
          {value.node && !sources.some((node) => node.id === value.node) && (
            <option value={value.node} disabled>
              {value.node} · {t("absent")}
            </option>
          )}
          {sources.map((node) => (
            <option key={node.id} value={node.id}>
              {templateLabel(node.template || node.id, node.label, t)}
            </option>
          ))}
        </Select>
      </label>
      <label className="field">
        <span>{t("valueSourcePort")}</span>
        <Select
          aria-label={t("valueSourcePort")}
          value={value.port || ""}
          onChange={(e) =>
            set({ port: e.target.value || undefined, column: "" })
          }
        >
          <option value="">
            {ports.length === 1
              ? `${ports[0]} · ${t("uniqueOutputHint")}`
              : t("uniqueOutputHint")}
          </option>
          {value.port && !ports.includes(value.port) && (
            <option value={value.port} disabled>
              {value.port} · {t("absent")}
            </option>
          )}
          {ports.map((port) => (
            <option key={port} value={port}>
              {port}
            </option>
          ))}
        </Select>
      </label>
      <ColumnPicker
        allowNone={false}
        node={value.node}
        port={value.port || ports[0] || "result"}
        value={value.column}
        label={t("valueSourceColumn")}
        onChange={(column) => set({ column })}
      />
    </>
  );
}

/** Offer known schema columns; before the first run, a declaration remains editable. */
export function ColumnPicker({
  node,
  port,
  value,
  label,
  disabled,
  allowNone = true,
  onChange,
}: {
  node: string;
  port: string;
  value: string;
  label: string;
  disabled?: boolean;
  allowNone?: boolean;
  onChange: (column: string) => void;
}) {
  const t = useT();
  const worktree = useOptionalWorktree();
  const bundle = worktree?.snapshot?.bundle;
  const source = bundle ? outputSource(bundle, node, port) : { node, port };
  const current =
    worktree?.statuses.nodes?.[source.node]?.outputs?.[source.port]?.columns;
  const partitioned =
    worktree?.snapshot?.partitions?.[worktree.environment]?.nodes[source.node]
      ?.partitioned;
  const retained = useApiResource<PreviewPage>(
    !current?.length && partitioned && worktree?.partition?.manifest
      ? withQuery(
          `/worktrees/${worktree.id}/preview/${encodeURIComponent(source.node)}`,
          {
            environment: worktree.environment,
            port: source.port,
            limit: 1,
            ...worktree.partition,
          },
        )
      : null,
  );
  const columns = current || retained.data?.columns || [];
  return (
    <label className="field">
      <span>{label}</span>
      {columns.length ? (
        <Select
          aria-label={label}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{t(allowNone ? "partitionNoFilter" : "chooseColumn")}</option>
          {value && !columns.some((c) => c.name === value) && (
            <option value={value}>
              {value} · {t("absent")}
            </option>
          )}
          {columns.map((column) => (
            <option key={column.name} value={column.name}>
              {column.name} · {column.type}
            </option>
          ))}
        </Select>
      ) : (
        <>
          <input
            aria-label={label}
            disabled={disabled}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <small className="muted">{t("partitionColumnHint")}</small>
        </>
      )}
    </label>
  );
}
