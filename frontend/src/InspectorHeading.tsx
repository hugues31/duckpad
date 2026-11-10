import { Boxes, Link, Settings2 } from "lucide-react";
import { templateLabel, useT } from "./i18n";
import type { FlowNode, Snapshot } from "./types";

export default function InspectorHeading({
  node,
  kind,
  snapshot,
}: {
  node: FlowNode;
  kind: "component" | import("./types").TemplateKind;
  snapshot: Snapshot;
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
    </div>
  );
}
