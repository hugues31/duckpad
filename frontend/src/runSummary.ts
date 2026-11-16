import { countLabel, type Translate } from "./i18n";
import type { Run } from "./types";

/**
 * What a successful run of the whole flow kept and computed, or nothing to say when
 * it computed every node.
 */
export function keptSummary(run: Run, t: Translate) {
  if (run.status !== "success" || run.scope !== "project") return "";
  const nodes = Object.values(run.nodes);
  const kept = nodes.filter((node) => node.kept).length;
  if (!kept) return "";
  if (kept === nodes.length) return t("runKeptEverything");
  return [
    countLabel(t, nodes.length - kept, "nodeRunOne", "nodeRunCount"),
    countLabel(t, kept, "keptResultOne", "keptResultCount"),
  ].join(" · ");
}
