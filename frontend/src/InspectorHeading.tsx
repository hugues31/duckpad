import { Link, X } from "lucide-react";
import { NodeIcon } from "./CanvasNode";
import { templateLabel, useT } from "./i18n";
import { colorClass, nodeIconKind } from "./nodeAppearance";
import type { FlowNode, ParsedTemplate, Snapshot } from "./types";

/** The selected node's icon and name over its kind, as the code panel names its node. */
export default function InspectorHeading({
  title,
  node,
  kind,
  definition,
  snapshot,
  onClose,
}: {
  title: string;
  node: FlowNode;
  kind: "component" | import("./types").TemplateKind;
  /** The node's parsed code, which may declare an icon and a color. */
  definition?: Pick<ParsedTemplate, "icon" | "color">;
  snapshot: Snapshot;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="inspector-title">
      <span
        className={`kind-icon ${node.component ? "component" : colorClass(definition?.color)}`}
      >
        <NodeIcon
          kind={nodeIconKind(node)}
          icon={definition?.icon}
          size={18}
          aria-hidden="true"
        />
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
