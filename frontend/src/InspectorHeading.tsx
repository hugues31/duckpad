import { Boxes, Link, Settings2, X } from "lucide-react";
import { templateLabel, useT } from "./i18n";
import type { FlowNode, Snapshot } from "./types";

/** The selected node's name over its kind, as the code panel names its node. */
export default function InspectorHeading({
  title,
  node,
  kind,
  snapshot,
  onClose,
}: {
  title: string;
  node: FlowNode;
  kind: "component" | import("./types").TemplateKind;
  snapshot: Snapshot;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="inspector-title">
      <span className={`kind-icon ${node.component ? "component" : ""}`}>
        {node.component ? <Boxes size={18} /> : <Settings2 size={18} />}
      </span>
      <span className="panel-heading">
        <span title={title}>{title}</span>
        <small className="muted">
          {t(kind)}
          {" · "}
          {node.template ? (
            <>
              <Link size={11} aria-hidden="true" />
              {t("linkedNode")} ·{" "}
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
      </span>
      <button className="icon" onClick={onClose} title={t("close")}>
        <X size={18} />
      </button>
    </div>
  );
}
