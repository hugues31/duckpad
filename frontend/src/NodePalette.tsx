import { useMemo, useState } from "react";
import { Boxes, Code2, Plus, Search, X } from "lucide-react";
import { NodeIcon } from "./Canvas";
import { DRAG_TYPE, nodeChoices, type NodeKind } from "./graph";
import { templateLabel, useT } from "./i18n";
import type { Snapshot } from "./types";

export type { NodeKind } from "./graph";

const CATEGORIES = ["sources", "transforms", "components", "exports"] as const;

export default function NodePalette({
  readOnly,
  snapshot,
  excludedComponents,
  hidden,
  onClose,
  onAdd,
  onNewTemplate,
  onLibrary,
}: {
  readOnly: boolean;
  snapshot: Snapshot;
  /** The opened component definitions, which the graph cannot contain. */
  excludedComponents: string[];
  hidden: boolean;
  onClose: () => void;
  onAdd: (kind: NodeKind, id: string) => void;
  onNewTemplate: () => void;
  onLibrary: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const items = useMemo(() => {
    const query = search.toLowerCase();
    return nodeChoices(
      snapshot.parsed_templates,
      snapshot.bundle?.components || {},
      excludedComponents,
    )
      .map((choice) => ({
        id: choice.id,
        kind: choice.kind,
        label:
          choice.kind === "component"
            ? choice.definition.name
            : templateLabel(choice.id, choice.definition.label, t),
        category:
          CATEGORIES.find(
            (category) => category === choice.signature.kind + "s",
          ) || "transforms",
        description: choice.definition.description,
      }))
      .filter((item) => item.label?.toLowerCase().includes(query));
  }, [snapshot, excludedComponents, search, t]);
  return (
    <aside
      className="palette"
      id="node-palette"
      aria-label={t("nodes")}
      hidden={hidden}
    >
      <div className="palette-title">
        <span>{t("nodes")}</span>
        <span className="counter">{items.length}</span>
        <button className="icon" title={t("hideNodes")} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="search">
        <Search size={14} />
        <input
          placeholder={t("searchNodes")}
          aria-label={t("searchNodes")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="palette-list">
        {CATEGORIES.map((category) => (
          <section key={category}>
            <h4>{t(category)}</h4>
            {items
              .filter((item) => item.category === category)
              .map((item) => (
                <button
                  className="palette-item"
                  key={item.id}
                  draggable={!readOnly}
                  disabled={readOnly}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(
                      DRAG_TYPE,
                      JSON.stringify({ kind: item.kind, id: item.id }),
                    );
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onAdd(item.kind, item.id)}
                  title={item.description}
                >
                  <span className={`palette-icon ${item.category}`}>
                    <NodeIcon
                      kind={item.kind === "component" ? "component" : item.id}
                      size={17}
                    />
                  </span>
                  <span>{item.label}</span>
                  <Plus size={12} className="palette-plus" />
                </button>
              ))}
          </section>
        ))}
      </div>
      <fieldset className="palette-bottom" disabled={readOnly}>
        <button className="text-button" onClick={onNewTemplate}>
          <Code2 size={14} />
          {t("newTemplate")}
        </button>
        <button className="text-button" onClick={onLibrary}>
          <Boxes size={14} />
          {t("library")}
        </button>
        <p>{t("dragHint")}</p>
      </fieldset>
    </aside>
  );
}
