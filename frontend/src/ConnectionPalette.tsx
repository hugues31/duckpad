import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Search, X } from "lucide-react";
import { nodeIcon } from "./Canvas";
import { templateLabel, useT } from "./i18n";
import type { NodeKind } from "./NodePalette";
import type { FlowNode, Json } from "./types";

export default function ConnectionPalette({
  parsed,
  components,
  excludedComponents,
  handleType,
  screen,
  onChoose,
  onClose,
}: {
  parsed: Record<string, Json>;
  components: Record<string, Json>;
  excludedComponents: string[];
  handleType: "source" | "target";
  screen: { x: number; y: number };
  onChoose: (kind: NodeKind, id: string, port: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const listId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState(screen);
  const portSide = handleType === "source" ? "inputs" : "outputs";
  const items = useMemo(() => {
    // A component cannot contain itself, including through another definition.
    const containsAncestor = (
      id: string,
      visited = new Set<string>(),
    ): boolean => {
      if (excludedComponents.includes(id)) return true;
      if (visited.has(id)) return false;
      visited.add(id);
      return (components[id]?.nodes || []).some(
        (node: FlowNode) =>
          node.component && containsAncestor(node.component, visited),
      );
    };
    const definitions = [
      ...Object.entries(parsed).map(([id, definition]) => ({
        id,
        kind: "template" as NodeKind,
        label: templateLabel(id, definition.label, t),
        description: definition.description || "",
        ports: (definition[portSide] || []) as string[],
      })),
      ...Object.entries(components)
        .filter(([id]) => !containsAncestor(id))
        .map(([id, definition]) => ({
          id,
          kind: "component" as NodeKind,
          label: definition.name || id,
          description: definition.description || "",
          ports: Object.keys(definition[portSide] || {}),
        })),
    ];
    const query = search.trim().toLocaleLowerCase();
    return definitions
      .flatMap(({ ports, ...item }) => ports.map((port) => ({ ...item, port })))
      .filter((item) =>
        `${item.label} ${item.id} ${item.description} ${item.port}`
          .toLocaleLowerCase()
          .includes(query),
      );
  }, [parsed, components, excludedComponents, portSide, search, t]);
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  useLayoutEffect(() => {
    const measure = () => {
      const bounds = dialog.current!.getBoundingClientRect();
      setPosition({
        x: Math.max(
          8,
          Math.min(screen.x, window.innerWidth - bounds.width - 8),
        ),
        y: Math.max(
          8,
          Math.min(screen.y, window.innerHeight - bounds.height - 8),
        ),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(dialog.current!);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [screen]);
  useEffect(() => {
    input.current?.focus();
    const dismissOutside = (event: PointerEvent) => {
      if (!dialog.current?.contains(event.target as globalThis.Node)) onClose();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () =>
      document.removeEventListener("pointerdown", dismissOutside, true);
  }, [onClose]);
  useEffect(() => {
    document
      .getElementById(`${listId}-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, listId, items]);

  return createPortal(
    <div
      ref={dialog}
      className="connection-palette"
      role="dialog"
      aria-label={t("addConnectedNode")}
      style={{ left: position.x, top: position.y }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onClose();
      }}
    >
      <div className="connection-palette-title">
        <strong>{t("addConnectedNode")}</strong>
        <button className="icon" aria-label={t("close")} onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="search">
        <Search size={15} aria-hidden="true" />
        <input
          ref={input}
          role="combobox"
          aria-label={t("searchNodes")}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={
            items.length ? `${listId}-${activeIndex}` : undefined
          }
          placeholder={t("searchNodes")}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (items.length)
                setActive(
                  (activeIndex +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                    items.length,
                );
            } else if (event.key === "Enter") {
              event.preventDefault();
              const item = items[activeIndex];
              if (item) onChoose(item.kind, item.id, item.port);
            }
          }}
        />
      </div>
      <div
        id={listId}
        role="listbox"
        aria-label={t("compatibleNodes")}
        className="connection-palette-list"
      >
        {items.map((item, index) => {
          const Icon = nodeIcon(
            item.kind === "component" ? "component" : item.id,
          );
          return (
            <button
              key={`${item.kind}:${item.id}:${item.port}`}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              className="connection-palette-item"
              title={item.description}
              onPointerMove={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onChoose(item.kind, item.id, item.port)}
            >
              <Icon size={19} aria-hidden="true" />
              <span>
                <strong>{item.label}</strong>
                <small>
                  {t(portSide)} · {item.port}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {!items.length && (
        <p role="status" className="connection-palette-empty">
          {t("noCompatibleNodes")}
        </p>
      )}
      <p className="connection-palette-hint">{t("connectionPaletteHint")}</p>
    </div>,
    document.body,
  );
}
