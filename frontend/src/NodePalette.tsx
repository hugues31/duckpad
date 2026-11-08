import { Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ActionMenu } from "./ActionMenu";
import AddIcon from "./AddIcon";
import { NodeIcon } from "./CanvasNode";
import { DRAG_TYPE, nodeChoices, type NodeKind } from "./graph";
import { isBuiltinTemplate, templateLabel, useT } from "./i18n";
import type { Snapshot } from "./types";

const CATEGORIES = [
  "sources",
  "transforms",
  "components",
  "exports",
  "projectTemplates",
] as const;

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
  const [context, setContext] = useState<{
    id: string;
    position: { x: number; y: number };
    trigger: HTMLButtonElement;
  } | null>(null);
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
          choice.kind === "template" && !isBuiltinTemplate(choice.id)
            ? "projectTemplates"
            : CATEGORIES.find(
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
          placeholder={t("searchNodeTypes")}
          aria-label={t("searchNodeTypes")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="palette-list">
        {CATEGORIES.filter((category) =>
          items.some((item) => item.category === category),
        ).map((category) => (
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
                    onClick={(event) =>
                      onAdd(
                        item.kind,
                        item.id,
                        item.kind === "template" && event.altKey,
                      )
                    }
                    onContextMenu={(event) => {
                      if (readOnly || item.kind !== "template") return;
                      event.preventDefault();
                      setContext({
                        id: item.id,
                        position: { x: event.clientX, y: event.clientY },
                        trigger: event.currentTarget,
                      });
                    }}
                    title={[
                      item.description,
                      item.kind === "template" ? t("addLinkedHint") : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
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
                </div>
              ))}
          </section>
        ))}
      </div>
      {context && !readOnly && (
        <ActionMenu
          label={t("addLinked")}
          position={context.position}
          items={[
            {
              id: "linked",
              label: t("addLinked"),
              run: () => onAdd("template", context.id, true),
            },
          ]}
          onClose={() => {
            setContext(null);
            context.trigger.focus();
          }}
        />
      )}
      <fieldset
        className="palette-bottom"
        disabled={readOnly}
        aria-label={t("addToPalette")}
      >
        <div className="palette-actions">
          <button
            className="button secondary small"
            title={t("newTemplate")}
            aria-label={t("newTemplate")}
            onClick={() => onNewTemplate("sql")}
          >
            <AddIcon glyph="duckdb" />
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
            <AddIcon glyph="python" />
            {t("python")}
          </button>
          <button
            className="button secondary small"
            title={t("library")}
            aria-label={t("library")}
            onClick={onLibrary}
          >
            <AddIcon glyph="import" />
            {t("paletteImport")}
          </button>
        </div>
      </fieldset>
    </aside>
  );
}
