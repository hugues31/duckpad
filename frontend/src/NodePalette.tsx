import { useMemo, useState } from "react";
import { Code2, Download, Link, Plus, Search, X } from "lucide-react";
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
  onAdd: (kind: NodeKind, id: string, linked?: boolean) => void;
  onNewTemplate: (language: "sql" | "python") => void;
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
                <div className="palette-entry" key={item.id}>
                  <button
                    className="palette-item"
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
                        kind={
                          item.kind === "component"
                            ? "component"
                            : item.id.endsWith(".py")
                              ? "python"
                              : item.id
                        }
                        size={17}
                      />
                    </span>
                    <span>{item.label}</span>
                    <Plus size={12} className="palette-plus" />
                  </button>
                  {item.kind === "template" && (
                    <button
                      className="icon palette-link"
                      disabled={readOnly}
                      title={t("addLinked")}
                      aria-label={`${t("addLinked")}: ${item.label}`}
                      onClick={() => onAdd(item.kind, item.id, true)}
                    >
                      <Link size={14} />
                    </button>
                  )}
                </div>
              ))}
          </section>
        ))}
      </div>
      <fieldset
        className="palette-bottom"
        disabled={readOnly}
        aria-label={t("addToPalette")}
      >
        <span className="palette-actions-label" aria-hidden="true">
          {t("addToPalette")}
        </span>
        <div className="palette-actions">
          <button
            className="button secondary small"
            title={t("newTemplate")}
            aria-label={t("newTemplate")}
            onClick={() => onNewTemplate("sql")}
          >
            <Code2 size={15} aria-hidden="true" />
            {t("sql")}
          </button>
          <button
            className="button secondary small"
            disabled={!snapshot.python_enabled}
            title={t(
              snapshot.python_enabled
                ? "newPythonTemplate"
                : "pythonDisabledHint",
            )}
            aria-label={t("newPythonTemplate")}
            onClick={() => onNewTemplate("python")}
          >
            <NodeIcon kind="python" size={15} aria-hidden="true" />
            {t("python")}
          </button>
          <button
            className="button secondary small"
            title={t("library")}
            aria-label={t("library")}
            onClick={onLibrary}
          >
            <Download size={15} aria-hidden="true" />
            {t("paletteImport")}
          </button>
        </div>
      </fieldset>
    </aside>
  );
}
