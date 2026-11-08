import { Boxes, Link, Loader2, Play, Settings2 } from "lucide-react";
import { templateLabel, useT } from "./i18n";
import type { FlowNode, Snapshot, Statuses } from "./types";

export default function InspectorHeading({
  node,
  kind,
  snapshot,
  readOnly,
  starting,
  statuses,
  onRun,
}: {
  node: FlowNode;
  kind: "component" | import("./types").TemplateKind;
  snapshot: Snapshot;
  readOnly: boolean;
  starting: boolean | undefined;
  statuses: Statuses;
  onRun: () => void;
}) {
  const t = useT();
  return (
    <div className="inspector-kind">
      <span className={`kind-icon ${node.component ? "component" : ""}`}>
        {node.component ? <Boxes size={18} /> : <Settings2 size={18} />}
      </span>
      <div>
        <strong>{t(kind)}</strong>
        <small>
          {node.template ? (
            <>
              <Link size={12} /> {t("linkedNode")} ·{" "}
              {templateLabel(
                node.template,
                snapshot.parsed_templates[node.template]?.label,
                t,
              )}
            </>
          ) : (
            node.component || t("normalNode")
          )}
        </small>
      </div>
      <button
        className="icon run-node"
        title={t("runNode")}
        disabled={readOnly || starting || !!statuses.active}
        aria-busy={starting}
        onClick={onRun}
      >
        {starting ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
      </button>
    </div>
  );
}
