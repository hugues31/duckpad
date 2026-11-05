import { displayNodeName } from "./nodeNames";
import type { Translate } from "./i18n";
import type { Run } from "./types";

/** Use captured names so renaming or removing a node cannot rewrite history. */
export function runScopeLabel(run: Run, t: Translate) {
  if (run.scope === "project") return t("fullRun");
  return displayNodeName(
    run.scope_name,
    run.nodes[run.scope]?.label || t("node"),
    t,
  );
}
