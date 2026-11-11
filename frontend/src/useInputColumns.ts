import { useMemo } from "react";
import { withQuery } from "./api";
import type { InputColumns } from "./draftPreview";
import { outputSource, pathPrefix, resolveNodePath } from "./graph";
import { nodeCodePath } from "./nodeCode";
import type { Snapshot, Statuses } from "./types";
import { useApiResource } from "./useApiResource";
import { usePartitionQuery } from "./worktree";

/** Columns of expanded inputs, including connections across component boundaries. */
export function useInputColumns(
  snapshot: Snapshot,
  fullNode: string,
  environment: string,
  statuses: Statuses,
) {
  const partition = usePartitionQuery(fullNode);
  // Keep the refresh key small; never serialize result rows or schemas on each keystroke.
  const refresh = useMemo(() => {
    const bundle = snapshot.bundle;
    const located = bundle && resolveNodePath(bundle, fullNode);
    if (!bundle || !located) return "";
    const { node, parent } = located;
    const declared =
      snapshot.parsed_nodes?.[nodeCodePath(node.id, parent, node.language)] ??
      (node.template ? snapshot.parsed_templates[node.template] : undefined);
    const inputs = node.component
      ? Object.keys(bundle.components[node.component]?.inputs || {})
      : declared?.inputs || [];
    const sourceOf = (
      target: string,
      port: string,
    ): ReturnType<typeof outputSource> | null => {
      const location = resolveNodePath(bundle, target);
      if (!location) return null;
      const edge = location.graph.edges.find(
        (edge) => edge.target === location.id && edge.targetHandle === port,
      );
      if (edge)
        return outputSource(
          bundle,
          pathPrefix(location.path) + edge.source,
          edge.sourceHandle,
        );
      if (!location.parent) return null;
      const exposed = Object.entries(
        bundle.components[location.parent].inputs || {},
      ).find(([, input]) => input.node === location.id && input.port === port);
      return exposed
        ? sourceOf(target.split("::").slice(0, -1).join("::"), exposed[0])
        : null;
    };
    return JSON.stringify([
      inputs,
      statuses.active?.id,
      inputs.map((port) => {
        const source = sourceOf(fullNode, port);
        const result =
          source && statuses.nodes[source.node]?.outputs[source.port];
        return [port, source, result?.id, result?.status];
      }),
    ]);
  }, [
    snapshot.bundle,
    snapshot.parsed_nodes,
    snapshot.parsed_templates,
    fullNode,
    statuses.active?.id,
    statuses.nodes,
  ]);
  // A template opened outside any node has no inputs to describe.
  const resource = useApiResource<InputColumns>(
    fullNode
      ? withQuery(
          `/worktrees/${snapshot.worktree.id}/input-columns/${encodeURIComponent(fullNode)}`,
          { environment, ...partition },
        )
      : null,
    { refresh },
  );
  const columns = useMemo(
    () =>
      Object.fromEntries(
        (resource.data?.inputs || []).map((input) => [
          input.input,
          input.columns || [],
        ]),
      ),
    [resource.data],
  );
  return { ...resource, columns };
}
