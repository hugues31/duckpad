import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import { useT } from "./i18n";
import { projectFileLanguage } from "./projectFiles";
import Select from "./Select";
import type { Json } from "./types";

const CodeDiff = lazy(() =>
  import("./Editor").then((module) => ({ default: module.CodeDiff })),
);
const SYMBOL: Record<string, string> = {
  added: "+",
  removed: "−",
  modified: "~",
  unchanged: "=",
};
const valueText = (value: unknown) =>
  value === undefined || value === null
    ? "—"
    : typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

function ComparisonGraph({
  entities,
  scope,
  selected,
  onSelect,
}: {
  entities: Json[];
  scope: string;
  selected: string;
  onSelect: (id: string) => void;
}) {
  const t = useT();
  const { fitView } = useReactFlow();
  const nodes = useMemo(
    () =>
      entities
        .filter((e) => e.kind === "node" && e.scope === scope)
        .map((e, index) => {
          const node = e.after || e.before;
          return {
            id: e.id,
            position: node.position || {
              x: (index % 4) * 210,
              y: Math.floor(index / 4) * 100,
            },
            selected: e.id === selected,
            className: `comparison-node change-${e.status}`,
            sourcePosition: Position.Right,
            targetPosition: Position.Left,
            data: { label: `${SYMBOL[e.status]} ${e.name} · ${t(e.status)}` },
          };
        }),
    [entities, scope, selected, t],
  );
  const edges = useMemo(
    () =>
      entities
        .filter((e) => e.kind === "edge" && e.scope === scope)
        .flatMap((e) => {
          const versions =
            e.status === "modified"
              ? [
                  ["before", e.before],
                  ["after", e.after],
                ]
              : [
                  [
                    e.status === "removed" ? "before" : "after",
                    e.after || e.before,
                  ],
                ];
          return versions
            .filter(([, value]) => value)
            .map(([side, value]) => ({
              id: `${e.id}/${side}`,
              source: `${scope ? scope + "/" : ""}node/${value.source}`,
              target: `${scope ? scope + "/" : ""}node/${value.target}`,
              data: { entity: e.id },
              label: `${SYMBOL[e.status]} ${value.sourceHandle} → ${value.targetHandle} (${t(side)})`,
              selected: selected === e.id,
              style: {
                stroke:
                  e.status === "added"
                    ? "var(--success)"
                    : e.status === "removed"
                      ? "var(--danger)"
                      : "var(--muted)",
                strokeDasharray: side === "before" ? "6 4" : undefined,
                strokeWidth: selected === e.id ? 3 : 1.5,
              },
            }));
        }),
    [entities, scope, selected, t],
  );
  useEffect(() => {
    const timer = setTimeout(() => fitView({ padding: 0.2, maxZoom: 1 }), 50);
    return () => clearTimeout(timer);
  }, [scope, entities, fitView]);
  return (
    <div className="comparison-graph" aria-label={t("readOnlyGraph")}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodesDraggable={false}
        nodesConnectable={false}
        deleteKeyCode={null}
        onNodeClick={(_, node) => onSelect(node.id)}
        onEdgeClick={(_, edge) => onSelect(edge.data!.entity)}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        ariaLabelConfig={{
          "controls.ariaLabel": t("canvasControls"),
          "controls.zoomIn.ariaLabel": t("zoomIn"),
          "controls.zoomOut.ariaLabel": t("zoomOut"),
          "controls.fitView.ariaLabel": t("fitView"),
          "node.a11yDescription.default": t("readOnlyGraph"),
          "edge.a11yDescription.default": t("readOnlyGraph"),
        }}
        minZoom={0.1}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
      <button
        className="button secondary small comparison-focus"
        onClick={() => {
          const node = nodes.find((n) => n.id === selected);
          const edge = edges.find((e) => e.data.entity === selected);
          fitView({
            nodes: node
              ? [node]
              : edge
                ? nodes.filter(
                    (n) => n.id === edge.source || n.id === edge.target,
                  )
                : nodes,
            padding: 0.5,
            maxZoom: 1.4,
          });
        }}
      >
        {t("focusChange")}
      </button>
    </div>
  );
}

export default function ComparisonView({
  report,
  storageKey,
  onHistory,
}: {
  report: Json;
  storageKey: string;
  onHistory?: (entity: string) => void;
}) {
  const t = useT();
  const [filters, setFilters] = useState(() => {
    try {
      return {
        only: true,
        category: "all",
        search: "",
        ...JSON.parse(sessionStorage.getItem(storageKey) || "{}"),
      };
    } catch {
      return { only: true, category: "all", search: "" };
    }
  });
  const [selected, setSelected] = useState("");
  const [scope, setScope] = useState("");
  useEffect(() => {
    sessionStorage.setItem(storageKey, JSON.stringify(filters));
  }, [storageKey, filters]);
  const entities: Json[] = report.entities;
  const filtered = entities.filter(
    (e) =>
      (!filters.only || e.status !== "unchanged") &&
      (filters.category === "all" || e.categories.includes(filters.category)) &&
      `${e.name} ${e.id} ${e.fields.join(" ")}`
        .toLowerCase()
        .includes(filters.search.toLowerCase()),
  );
  const active = entities.find((e) => e.id === selected) || filtered[0];
  const choose = (id: string) => {
    setSelected(id);
    const entity = entities.find((e) => e.id === id);
    if (entity) setScope(entity.scope);
  };
  const index = filtered.findIndex((e) => e.id === active?.id);
  return (
    <div className="comparison-view">
      <div className="git-controls">
        <label>
          <input
            type="checkbox"
            checked={filters.only}
            onChange={(e) => setFilters({ ...filters, only: e.target.checked })}
          />{" "}
          {t("onlyChanges")}
        </label>
        <label>
          {t("changeCategory")}{" "}
          <Select
            aria-label={t("changeCategory")}
            value={filters.category}
            onChange={(e) =>
              setFilters({ ...filters, category: e.target.value })
            }
          >
            {["all", "processing", "documentation", "layout"].map((c) => (
              <option key={c} value={c}>
                {t(c)}
                {c !== "all" ? ` (${report.categories[c] || 0})` : ""}
              </option>
            ))}
          </Select>
        </label>
        <input
          type="search"
          aria-label={t("searchChanges")}
          placeholder={t("searchChanges")}
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
        />
        <span aria-live="polite">
          {filtered.length} {t("elements")}
        </span>
        <button
          className="button secondary small"
          disabled={index <= 0}
          onClick={() => choose(filtered[index - 1].id)}
        >
          {t("previousChange")}
        </button>
        <button
          className="button secondary small"
          disabled={index < 0 || index >= filtered.length - 1}
          onClick={() => choose(filtered[index + 1].id)}
        >
          {t("nextChange")}
        </button>
      </div>
      <div className="git-legend">
        {["added", "removed", "modified", "unchanged"].map((status) => (
          <span key={status}>
            {SYMBOL[status]} {t(status)}: {report.counts[status] || 0}
          </span>
        ))}
      </div>
      {report.diagnostics?.map((d: Json, i: number) => (
        <p className="notice error" key={i}>
          {d.side}: {d.message}
        </p>
      ))}
      <div className="comparison-body">
        <nav className="change-list" aria-label={t("changedElements")}>
          {filtered.length === 0 && <p className="muted">{t("noChanges")}</p>}
          {filtered.map((e) => (
            <button
              key={e.id}
              className={`change-row change-${e.status} ${active?.id === e.id ? "active" : ""}`}
              aria-pressed={active?.id === e.id}
              onClick={() => choose(e.id)}
            >
              <strong>
                {SYMBOL[e.status]} {e.name}
              </strong>
              <small>
                {t(e.kind)} · {e.categories.map((c: string) => t(c)).join(", ")}
              </small>
              <small>{e.scope || e.file}</small>
            </button>
          ))}
        </nav>
        <div className="comparison-detail">
          <label className="git-scope">
            {t("componentScope")}{" "}
            <Select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">{t("flow")}</option>
              {entities
                .filter((e) => e.kind === "component")
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name} · {e.id}
                  </option>
                ))}
            </Select>
          </label>
          <ReactFlowProvider>
            <ComparisonGraph
              entities={entities}
              scope={scope}
              selected={active?.id || ""}
              onSelect={choose}
            />
          </ReactFlowProvider>
          {active && (
            <section
              className="comparison-inspector"
              aria-label={t("beforeAfter")}
            >
              <div className="row gap">
                <h3>
                  {SYMBOL[active.status]} {active.name}
                </h3>
                {onHistory && (
                  <button
                    className="button secondary small"
                    onClick={() => onHistory(active.id)}
                  >
                    {t("elementHistory")}
                  </button>
                )}
              </div>
              <p className="muted">
                {active.id} · {active.file}
              </p>
              {active.kind === "template" || active.kind === "file" ? (
                <Suspense fallback={<p>{t("loading")}</p>}>
                  <CodeDiff
                    before={valueText(
                      active.before === null ? "" : active.before,
                    )}
                    after={valueText(active.after === null ? "" : active.after)}
                    language={projectFileLanguage(active.file)}
                  />
                </Suspense>
              ) : (
                <table className="comparison-values">
                  <thead>
                    <tr>
                      <th>{t("field")}</th>
                      <th>{t("before")}</th>
                      <th>{t("after")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(typeof (active.after || active.before) === "object" &&
                    (active.after || active.before) !== null
                      ? Array.from(
                          new Set([
                            ...Object.keys(active.before || {}),
                            ...Object.keys(active.after || {}),
                          ]),
                        ).sort()
                      : ["value"]
                    ).map((field) => (
                      <tr key={field}>
                        <th>{field}</th>
                        {[active.before, active.after].map((value, i) => (
                          <td key={i}>
                            <pre>
                              {valueText(
                                field === "value" && typeof value !== "object"
                                  ? value
                                  : value?.[field],
                              )}
                            </pre>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {active.kind === "variable" && (
                <p className="comparison-usages">
                  <strong>{t("affectedNodes")}</strong>:{" "}
                  {active.usages?.length
                    ? active.usages
                        .map((usage: Json) => `${usage.label} (${usage.param})`)
                        .join(", ")
                    : t("notUsed")}
                </p>
              )}
            </section>
          )}
        </div>
      </div>
      {report.impact && (
        <details className="git-impact">
          <summary>
            {t("potentialImpact")} ·{" "}
            {t(
              report.impact.status === "partial"
                ? "analysisPartial"
                : report.impact.status,
            )}{" "}
            · {report.impact.downstream.length} {t("downstreamElements")}
          </summary>
          <p>
            {t(
              report.impact.status === "not_applicable"
                ? "noProcessingImpact"
                : "staticImpactHint",
            )}
          </p>
          <p>
            <strong>{t("directChanges")}</strong>:{" "}
            {report.impact.direct.join(", ") || "—"}
          </p>
          <p>
            <strong>{t("downstreamElements")}</strong>:{" "}
            {report.impact.downstream.join(", ") || "—"}
          </p>
          {report.impact.diagnostics.map((d: Json, i: number) => (
            <p key={i}>
              {d.node}: {d.message}
            </p>
          ))}
          <div className="git-wiring">
            {["before", "after"].map((side) => (
              <section key={side}>
                <h4>
                  {t(side)} · {t("wiring")}
                </h4>
                {report.impact[side + "_wiring"].map((edge: Json) => (
                  <p key={edge.id}>
                    <code>
                      {edge.source}.{edge.sourceHandle} → {edge.target}.
                      {edge.targetHandle}
                    </code>
                  </p>
                ))}
                <h4>{t("instanceScopes")}</h4>
                <pre>
                  {JSON.stringify(report.impact[side + "_scopes"], null, 2)}
                </pre>
              </section>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
