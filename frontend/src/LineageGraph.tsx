import { useMemo, useRef } from "react";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type NodeProps,
  type Node,
  type ReactFlowInstance,
  type Viewport,
} from "@xyflow/react";
import { useT } from "./i18n";
import { formatValue } from "./types";
import {
  ancestry,
  investigationCoverage,
  type InvestigationStep,
  type DependencyKind,
} from "./lineageModel";

type CardData = {
  title: string;
  subtitle: string;
  coverage: string;
  active: boolean;
  select: () => void;
  kind: string;
};
export type CardNode = Node<CardData>;
function Card({ data }: NodeProps<CardNode>) {
  const t = useT();
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <button
        className={`lineage-graph-card ${data.active ? "selected" : ""} dependency-${data.kind}`}
        aria-pressed={data.active}
        onClick={data.select}
      >
        <strong>{data.title}</strong>
        <span>{data.subtitle}</span>
        <small>{t(data.coverage)}</small>
      </button>
      <Handle type="source" position={Position.Right} />
    </>
  );
}
const nodeTypes = { contribution: Card };
const styles: Record<string, { strokeDasharray?: string; stroke: string }> = {
  value: { stroke: "var(--accent)" },
  condition: { stroke: "var(--muted)", strokeDasharray: "7 4" },
  existence: { stroke: "var(--text)", strokeDasharray: "2 4" },
};
export default function LineageGraph({
  steps,
  selected,
  role,
  onSelect,
  search,
  isolated,
  components,
  projections,
  viewport,
  onViewport,
  instance,
}: {
  steps: InvestigationStep[];
  selected: string;
  role?: string;
  onSelect: (step: string, role?: string) => void;
  search: string;
  isolated: boolean;
  components: boolean;
  projections: boolean;
  viewport: Viewport;
  onViewport: (v: Viewport) => void;
  instance: React.RefObject<ReactFlowInstance<CardNode> | null>;
}) {
  const t = useT();
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const depthSlots = useRef(new Map<number, number>());
  const { nodes, edges } = useMemo(() => {
    const visible = isolated
      ? new Set(ancestry(steps, selected).map((s) => s.id))
      : new Set(steps.map((s) => s.id));
    const representative = new Map<string, string>();
    const groups = new Map<string, InvestigationStep[]>();
    const expanded = (step: InvestigationStep) =>
      step.stage?.node.split("::").slice(0, -1).join("::");
    for (const step of steps) {
      if (!visible.has(step.id)) continue;
      let group = step.id;
      if (components && expanded(step)) group = "component:" + expanded(step);
      else if (
        projections &&
        step.stage?.kind === "projection" &&
        step.id !== "target"
      ) {
        let parent = steps.find((s) => s.id === step.parent);
        group = "chain:" + step.id;
        while (parent?.stage?.kind === "projection" && parent.id !== "target") {
          group = "chain:" + parent.id;
          parent = steps.find((s) => s.id === parent?.parent);
        }
      }
      representative.set(step.id, group);
      groups.set(group, [...(groups.get(group) || []), step]);
    }
    const position = (id: string, depth: number) => {
      if (!positions.current.has(id)) {
        const slot = depthSlots.current.get(depth) || 0;
        positions.current.set(id, { x: -depth * 350, y: slot * 140 });
        depthSlots.current.set(depth, slot + 1);
      }
      return positions.current.get(id)!;
    };
    const nodes: CardNode[] = [];
    const edges: {
      id: string;
      source: string;
      target: string;
      label: string;
      style: (typeof styles)[string];
      markerEnd: { type: MarkerType };
    }[] = [];
    const edge = (source: string, target: string, kind: DependencyKind) => {
      if (source !== target)
        edges.push({
          id: source + ":" + target,
          source,
          target,
          label: t("dependency_" + kind),
          style: styles[kind],
          markerEnd: { type: MarkerType.ArrowClosed },
        });
    };
    for (const [id, members] of groups) {
      const step = members.find((s) => s.id === selected) || members[0];
      const stage = step.stage;
      const grouped = id.startsWith("component:") || id.startsWith("chain:");
      const coverage = members.some(
        (s) => investigationCoverage(steps, s.id) === "unsupported_operation",
      )
        ? "unsupported_operation"
        : members.some(
              (s) =>
                investigationCoverage(steps, s.id) === "upstream_not_explored",
            )
          ? "upstream_not_explored"
          : "sources_reached";
      const title = id.startsWith("component:")
        ? stage?.path.slice(0, -1).join(" / ") || id.slice(10)
        : id.startsWith("chain:")
          ? t("projectionChain")
          : stage?.label || step.cell.column;
      nodes.push({
        id,
        type: "contribution",
        position: position(id, members[0].depth * 2),
        data: {
          title,
          subtitle: grouped
            ? `${members.length} ${t("lineageSteps")} · ${t("expandGroupsHint")}`
            : `${stage?.port || ""} · ${step.cell.column} = ${stage ? formatValue(stage.value) : "…"} · #${step.cell.row}`,
          coverage,
          active: members.some((s) => s.id === selected) && !role,
          select: () => onSelect(step.id),
          kind: "value",
        },
      });
      for (const member of members) {
        if (member.parent && visible.has(member.parent)) {
          const parent = steps.find((s) => s.id === member.parent)!;
          const sourceRole = parent.stage?.roles.find(
            (r) => r.id === member.via,
          );
          const parentId = representative.get(parent.id)!;
          const roleId = parentId + ":" + member.via;
          edge(
            id,
            grouped && parentId === id ? parentId : roleId,
            sourceRole?.kind || "value",
          );
        }
        for (const r of member.stage?.roles || []) {
          // Roles and warnings remain visible even inside collapsed components.
          const roleId = id + ":" + r.id;
          if (nodes.some((n) => n.id === roleId)) continue;
          if (
            search &&
            !`${r.label} ${r.display_alias} ${r.column} ${r.path.join(" ")}`
              .toLowerCase()
              .includes(search.toLowerCase())
          )
            continue;
          nodes.push({
            id: roleId,
            type: "contribution",
            position: position(roleId, members[0].depth * 2 + 1),
            data: {
              title: `${r.label} · ${r.column}`,
              subtitle: `${r.side === "input" ? "" : t(r.side) + " · "}${r.display_alias} · ${r.port} · ${r.occurrences} ${t("sourceOccurrences")}`,
              coverage: r.coverage,
              active: member.id === selected && role === r.id,
              select: () => onSelect(member.id, r.id),
              kind: r.kind,
            },
          });
          edge(roleId, id, r.kind);
        }
      }
    }
    const ids = new Set(nodes.map((n) => n.id));
    return {
      nodes,
      edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)),
    };
  }, [
    steps,
    selected,
    role,
    onSelect,
    search,
    isolated,
    components,
    projections,
    t,
  ]);
  return (
    <div
      className="lineage-graph"
      aria-label={t("contributionGraph")}
      onKeyDown={(e) => {
        if (!e.altKey || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        const index = steps.findIndex((s) => s.id === selected);
        onSelect(
          steps[
            Math.max(
              0,
              Math.min(
                steps.length - 1,
                index + (e.key === "ArrowLeft" ? 1 : -1),
              ),
            )
          ].id,
        );
      }}
    >
      <ReactFlow<CardNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        minZoom={0.15}
        maxZoom={1.5}
        defaultViewport={viewport}
        onMoveEnd={(_, v) => onViewport(v)}
        onInit={(flow) => {
          instance.current = flow;
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
