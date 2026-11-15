import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Layers,
  Loader2,
  Search,
  Waypoints,
} from "lucide-react";
import { useT } from "./i18n";
import { displayNodeName, type NodeNames } from "./nodeNames";

export type ScopeMode = "project" | "node";

/**
 * A Job runs the whole project or one node with its upstream nodes. The two
 * modes are distinct choices; only the node mode offers a node list.
 */
export default function JobScopeField({
  mode,
  node,
  nodes,
  pending,
  onMode,
  onNode,
}: {
  mode: ScopeMode;
  node: string;
  nodes: NodeNames | null | undefined;
  pending: boolean;
  onMode: (mode: ScopeMode) => void;
  onNode: (node: string) => void;
}) {
  const t = useT();
  const id = useId();
  const choices = [
    {
      value: "project" as const,
      Icon: Layers,
      label: t("jobWholeProject"),
      hint: t("jobWholeProjectHint"),
    },
    {
      value: "node" as const,
      Icon: Waypoints,
      label: t("jobScopeNode"),
      hint: t("jobScopeNodeHint"),
    },
  ];
  return (
    <fieldset className="field job-scope">
      <legend>{t("jobScope")}</legend>
      <div className="scope-choices">
        {choices.map(({ value, Icon, label, hint }) => (
          <label className="scope-choice" key={value}>
            <input
              type="radio"
              name="job-scope-mode"
              checked={mode === value}
              onChange={() => onMode(value)}
              aria-label={label}
              aria-describedby={`${id}-${value}`}
            />
            <Icon size={16} aria-hidden="true" />
            <span>
              <strong>{label}</strong>
              <small id={`${id}-${value}`}>{hint}</small>
            </span>
          </label>
        ))}
      </div>
      {mode === "node" && (
        <NodePicker
          nodes={nodes}
          value={node}
          pending={pending}
          onSelect={onNode}
        />
      )}
    </fieldset>
  );
}

/** A collapsible, searchable choice among the nodes of the Job version. */
function NodePicker({
  nodes,
  value,
  pending,
  onSelect,
}: {
  nodes: NodeNames | null | undefined;
  value: string;
  pending: boolean;
  onSelect: (node: string) => void;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  // Nothing chosen yet: the list is what the user came for.
  const [open, setOpen] = useState(!value);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const options = Object.entries(nodes || {}).map(([key, parts]) => ({
    key,
    name: displayNodeName(parts.slice(-1), key, t),
    path: displayNodeName(parts.slice(0, -1), "", t),
    label: displayNodeName(parts, key, t),
  }));
  const selected = options.find((option) => option.key === value);
  const words = query.trim().toLocaleLowerCase();
  const shown = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(words),
  );
  const index = Math.min(active, Math.max(0, shown.length - 1));
  useEffect(() => {
    // Scroll the list only: scrollIntoView would also scroll the dialog.
    const box = list.current;
    const item = box?.children[index] as HTMLElement | undefined;
    if (!box || !item) return;
    // Both offsets are measured from the same positioned ancestor.
    const top = item.offsetTop - box.offsetTop;
    if (top < box.scrollTop) box.scrollTop = top;
    else if (top + item.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = top + item.offsetHeight - box.clientHeight;
  }, [index, open]);
  const show = (next: boolean) => {
    setOpen(next);
    setQuery("");
    // Start from the chosen node, so arrows move from it.
    const at = options.findIndex((option) => option.key === value);
    setActive(next && at >= 0 ? at : 0);
  };
  const choose = (key: string) => {
    onSelect(key);
    setOpen(false);
    setQuery("");
  };
  return (
    <div
      className={`node-picker${open ? " open" : ""}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) show(false);
      }}
    >
      <div
        className="search"
        onMouseDown={(event) => {
          // The whole box toggles the list, like a select.
          if (event.target === input.current) return;
          event.preventDefault();
          input.current?.focus();
          show(!open);
        }}
      >
        {pending ? (
          <Loader2 size={16} className="spin" />
        ) : (
          <Search size={16} />
        )}
        <input
          ref={input}
          // Choosing the node mode leads straight to its list.
          autoFocus={!value}
          role="combobox"
          aria-label={t("node")}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          aria-activedescendant={
            open && shown.length ? `${id}-${index}` : undefined
          }
          maxLength={200}
          placeholder={selected?.label || t("jobScopeSearch")}
          value={open ? query : selected?.label || ""}
          onClick={() => {
            if (!open) show(true);
          }}
          onChange={(event) => {
            if (!open) show(true);
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              // Close the list before the dialog.
              event.stopPropagation();
              show(false);
            } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              if (!open) return show(true);
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive(
                (index + step + shown.length) % Math.max(1, shown.length),
              );
            } else if (event.key === "Enter" && open) {
              // Never submit the form while choosing.
              event.preventDefault();
              if (shown.length) choose(shown[index].key);
            }
          }}
        />
        <ChevronDown size={16} className="node-picker-chevron" />
      </div>
      {open && (
        <div className="node-picker-list">
          <div id={id} role="listbox" aria-label={t("node")} ref={list}>
            {shown.map((option, i) => (
              <div
                key={option.key}
                id={`${id}-${i}`}
                role="option"
                aria-selected={option.key === value}
                className={i === index ? "active" : undefined}
                title={option.key}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => i !== index && setActive(i)}
                onClick={() => choose(option.key)}
              >
                <Check size={14} aria-hidden="true" />
                <span>
                  <strong>{option.name}</strong>
                  {option.path && <small>{option.path}</small>}
                </span>
              </div>
            ))}
          </div>
          {(pending || !shown.length) && (
            <p className="search-status" role="status">
              {t(
                pending
                  ? "loading"
                  : nodes
                    ? "noSearchResults"
                    : "jobScopeNeedsVersion",
              )}
            </p>
          )}
        </div>
      )}
      {!value && !open && !pending && (
        <small className="muted">{t("jobScopeChooseNode")}</small>
      )}
    </div>
  );
}
