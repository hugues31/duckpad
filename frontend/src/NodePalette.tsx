import { useMemo, useState } from "react";
import { Boxes, Code2, Plus, Search, X } from "lucide-react";
import { nodeIcon } from "./Canvas";
import { DRAG_TYPE } from "./graph";
import { templateLabel, useT } from "./i18n";
import type { Snapshot } from "./types";

const CATEGORIES = ["sources", "transforms", "components", "exports"] as const;

export type NodeKind = "template" | "component";

export default function NodePalette({
  snapshot,
  hidden,
  onClose,
  onAdd,
  onNewTemplate,
  onLibrary,
}: {
  snapshot: Snapshot;
  hidden: boolean;
  onClose: () => void;
  onAdd: (kind: NodeKind, id: string) => void;
  onNewTemplate: () => void;
  onLibrary: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const items = useMemo(() => {
    const templates = Object.entries(snapshot.parsed_templates).map(
      ([id, definition]) => ({
        id,
        kind: "template" as NodeKind,
        label: templateLabel(id, definition.label, t),
        category:
          definition.kind === "source"
            ? "sources"
            : definition.kind === "export"
              ? "exports"
              : "transforms",
        description: definition.description,
      }),
    );
    const components = Object.entries(snapshot.bundle?.components || {}).map(
      ([id, definition]) => ({
        id,
        kind: "component" as NodeKind,
        label: definition.name,
        category: "components",
        description: definition.description,
      }),
    );
    const query = search.toLowerCase();
    return [...templates, ...components].filter((item) =>
      item.label?.toLowerCase().includes(query),
    );
  }, [snapshot, search, t]);
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
              .map((item) => {
                const Icon = nodeIcon(
                  item.kind === "component" ? "component" : item.id,
                );
                return (
                  <button
                    className="palette-item"
                    key={item.id}
                    draggable
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
                      <Icon size={17} />
                    </span>
                    <span>{item.label}</span>
                    <Plus size={12} className="palette-plus" />
                  </button>
                );
              })}
          </section>
        ))}
      </div>
      <div className="palette-bottom">
        <button className="text-button" onClick={onNewTemplate}>
          <Code2 size={14} />
          {t("newTemplate")}
        </button>
        <button className="text-button" onClick={onLibrary}>
          <Boxes size={14} />
          {t("library")}
        </button>
        <p>{t("dragHint")}</p>
      </div>
    </aside>
  );
}
