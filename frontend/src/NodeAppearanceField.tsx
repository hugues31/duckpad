import { ChevronDown, ChevronRight, Search } from "lucide-react";
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { NodeIcon } from "./CanvasNode";
import { useT } from "./i18n";
import {
  appearanceOf,
  colorClass,
  NODE_COLORS,
  nodeIconKind,
  type Appearance,
} from "./nodeAppearance";
import { findNodeIcons, type NodeIconGroup } from "./nodeIcons";
import type { FlowNode, ParsedTemplate, Snapshot } from "./types";

const GROUPS: [NodeIconGroup, "iconGroupData" | "iconGroupMisc"][] = [
  ["data", "iconGroupData"],
  ["misc", "iconGroupMisc"],
];

/** Arrow keys move the focus between the choices of a list laid out as a grid. */
function moveFocus(event: KeyboardEvent<HTMLElement>) {
  const options = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'),
  ];
  const current = options.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  const here = options[current].getBoundingClientRect();
  let target: HTMLElement | undefined;
  if (event.key === "ArrowLeft") target = options[current - 1];
  else if (event.key === "ArrowRight") target = options[current + 1];
  else if (event.key === "Home") target = options[0];
  else if (event.key === "End") target = options[options.length - 1];
  else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    // The closest choice of the nearest row in that direction, across groups.
    const down = event.key === "ArrowDown";
    const beyond = options
      .map((option) => ({ option, box: option.getBoundingClientRect() }))
      .filter(({ box }) =>
        down ? box.top > here.top + 1 : box.top < here.top - 1,
      );
    const row = Math.min(
      ...beyond.map(({ box }) => Math.abs(box.top - here.top)),
    );
    target = beyond
      .filter(({ box }) => Math.abs(Math.abs(box.top - here.top) - row) < 1)
      .sort(
        (a, b) =>
          Math.abs(a.box.left - here.left) - Math.abs(b.box.left - here.left),
      )[0]?.option;
  } else return;
  event.preventDefault();
  target?.focus();
}

/**
 * One choice of a list takes the Tab key: the one that has the focus, else the
 * selected one. The others are reached with the arrow keys.
 */
function useTabStop(listed: string[], selected: string) {
  const [focused, setFocused] = useState<string | null>(null);
  return {
    // A search can remove the focused choice without it losing the focus first.
    stop: focused !== null && listed.includes(focused) ? focused : selected,
    handlers: {
      onKeyDown: moveFocus,
      onFocus: (event: FocusEvent<HTMLElement>) =>
        setFocused(event.target.getAttribute("aria-label")),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(null);
      },
    },
  };
}

/**
 * The icon and the color of a node, chosen from the library. A choice is
 * written in the node's code as `@icon` and `@color`, where it can also be
 * typed; the canvas and the palette read it from there.
 */
export default function NodeAppearanceField({
  node,
  definition,
  snapshot,
  readOnly,
  onChange,
}: {
  node: FlowNode;
  /** The node's parsed code. */
  definition: ParsedTemplate | undefined;
  snapshot: Snapshot;
  readOnly: boolean;
  /** Write a change of icon or color in the node's code, from this revision. */
  onChange: (change: Appearance, base: Snapshot) => Promise<Snapshot>;
}) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  // A choice shows at once and stays until other code arrives: the saved code
  // then says what the node declares, as after an undo.
  const [chosen, setChosen] = useState<{
    appearance: Appearance;
    saving: boolean;
  } | null>(null);
  const [known, setKnown] = useState(definition);
  if (known !== definition) {
    setKnown(definition);
    if (chosen && !chosen.saving) setChosen(null);
  }
  const declared = appearanceOf(definition);
  const shown = chosen?.appearance ?? declared;
  const latest = useRef(snapshot);
  useLayoutEffect(() => {
    latest.current = snapshot;
  });
  // Choices save one after the other, each from the revision the previous one
  // made: two of them started from the same revision would conflict.
  const saves = useRef<{ last: Promise<Snapshot | null>; count: number }>({
    last: Promise.resolve(null),
    count: 0,
  });
  const choose = (change: Appearance) => {
    const next = { ...shown, ...change };
    setChosen({ appearance: next, saving: true });
    setError("");
    const queue = saves.current;
    queue.count++;
    // Only the change is written: the code may declare a name not shown here.
    const saving = queue.last.then((previous) =>
      onChange(change, previous ?? latest.current),
    );
    queue.last = saving.catch(() => null);
    void saving.then(
      () => {
        if (--queue.count) return;
        queue.last = Promise.resolve(null);
        setChosen((current) => current && { ...current, saving: false });
      },
      (failure: Error) => {
        if (!--queue.count) queue.last = Promise.resolve(null);
        // The code still declares what it did.
        setChosen(null);
        setError(failure.message);
      },
    );
  };
  const icons = findNodeIcons(search);
  const kind = nodeIconKind(node);
  const colors = useTabStop(
    [t("defaultColor"), ...NODE_COLORS],
    shown.color ?? t("defaultColor"),
  );
  // A search hides the default icon, and may hide the chosen one.
  const listed = [
    ...(search.trim() ? [] : [t("defaultIcon")]),
    ...icons.map((choice) => choice.name),
  ];
  const chosenIcon = shown.icon ?? t("defaultIcon");
  const shapes = useTabStop(
    listed,
    listed.includes(chosenIcon) ? chosenIcon : listed[0],
  );
  const unknown = (["icon", "color"] as const).filter(
    (key) => definition?.[key] && !declared[key],
  );
  const Toggle = open ? ChevronDown : ChevronRight;
  return (
    <div className="field appearance-field">
      <span id={`${id}-label`}>{t("nodeAppearance")}</span>
      <button
        type="button"
        className="appearance-toggle"
        aria-expanded={open}
        aria-controls={`${id}-picker`}
        aria-labelledby={`${id}-label ${id}-summary`}
        onClick={() => setOpen(!open)}
      >
        <span className={`kind-icon ${colorClass(shown.color)}`}>
          <NodeIcon
            kind={kind}
            icon={shown.icon}
            size={16}
            aria-hidden="true"
          />
        </span>
        <span id={`${id}-summary`} className="appearance-summary">
          {[shown.icon, shown.color].filter(Boolean).join(" · ") ||
            t("appearanceDefault")}
        </span>
        <Toggle size={14} aria-hidden="true" />
      </button>
      {unknown.map((key) => (
        <p key={key} className="muted small appearance-unknown">
          {t(
            key === "icon" ? "unknownIconNotice" : "unknownColorNotice",
            // A name is text, whatever it holds: "$&" is no pattern here.
          ).replace("{name}", () => definition![key]!)}
        </p>
      ))}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {open && (
        <div className="appearance-picker" id={`${id}-picker`}>
          <div
            className="appearance-colors"
            role="listbox"
            aria-label={t("nodeColorChoice")}
            aria-orientation="horizontal"
            {...colors.handlers}
          >
            {[undefined, ...NODE_COLORS].map((color) => {
              const label = color ?? t("defaultColor");
              return (
                <button
                  key={color ?? ""}
                  type="button"
                  role="option"
                  aria-selected={shown.color === color}
                  tabIndex={label === colors.stop ? 0 : -1}
                  disabled={readOnly}
                  className={`appearance-swatch ${color ? colorClass(color) : "default"}`}
                  title={label}
                  aria-label={label}
                  onClick={() => choose({ color })}
                />
              );
            })}
          </div>
          <div className="search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              placeholder={t("searchIcons")}
              aria-label={t("searchIcons")}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
          <div
            className={`appearance-icons ${colorClass(shown.color)}`}
            role="listbox"
            aria-label={t("nodeIconChoice")}
            {...shapes.handlers}
          >
            {!search.trim() && (
              <button
                type="button"
                role="option"
                aria-selected={!shown.icon}
                tabIndex={t("defaultIcon") === shapes.stop ? 0 : -1}
                disabled={readOnly}
                className="appearance-icon default"
                title={t("defaultIcon")}
                aria-label={t("defaultIcon")}
                onClick={() => choose({ icon: undefined })}
              >
                <NodeIcon kind={kind} size={18} aria-hidden="true" />
                <span>{t("defaultIcon")}</span>
              </button>
            )}
            {GROUPS.map(([group, label]) => {
              const choices = icons.filter((choice) => choice.group === group);
              if (!choices.length) return null;
              return (
                <div
                  key={group}
                  role="group"
                  aria-labelledby={`${id}-${group}`}
                >
                  <h5 id={`${id}-${group}`}>{t(label)}</h5>
                  <div className="appearance-grid">
                    {choices.map(({ name, Icon }) => (
                      <button
                        key={name}
                        type="button"
                        role="option"
                        aria-selected={shown.icon === name}
                        tabIndex={name === shapes.stop ? 0 : -1}
                        disabled={readOnly}
                        className="appearance-icon"
                        title={name}
                        aria-label={name}
                        onClick={() => choose({ icon: name })}
                      >
                        <Icon size={18} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            {!icons.length && (
              <p className="muted small" role="status">
                {t("noIconMatches")}
              </p>
            )}
          </div>
          <p className="muted small appearance-hint">
            {t(node.template ? "appearanceSharedHint" : "appearanceCodeHint")}
          </p>
        </div>
      )}
    </div>
  );
}
