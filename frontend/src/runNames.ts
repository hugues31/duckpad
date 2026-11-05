import { displayNodeName } from "./nodeNames";
import type { Translate } from "./i18n";
import type { Run } from "./types";

/** Use captured names so renaming or removing a node cannot rewrite history. */
export function runScopeLabel(run: Run, t: Translate) {
  if (run.scope === "project") return t("fullRun");
  // Older runs captured the graph but not a separate scope name. Component
  // instances have no execution entry of their own, only entries for children.
  if (!run.scope_name?.length && !run.nodes[run.scope]?.label && run.flow) {
    let nodes = run.flow.nodes;
    const labels: string[] = [];
    for (const id of run.scope.split("::")) {
      const node = nodes.find((item) => item.id === id);
      if (!node) return t("node");
      const component = node.component && run.components[node.component];
      labels.push(node.label || (component && component.name) || t("node"));
      nodes = component ? component.nodes : [];
    }
    return labels.join(" / ");
  }
  return displayNodeName(
    run.scope_name,
    run.nodes[run.scope]?.label || t("node"),
    t,
  );
}
