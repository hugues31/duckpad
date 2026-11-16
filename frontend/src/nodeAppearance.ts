/**
 * How a node looks: the icon and the color its code declares with `@icon` and
 * `@color`. Like the label, they never change what the node computes.
 */
import { appearanceName, NODE_ICONS, nodeIcon } from "./nodeIcons";
import type { FlowNode, ParsedTemplate } from "./types";

/** The names written after `@color`; each has a light and a dark tone. */
export const NODE_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "teal",
  "blue",
  "purple",
  "pink",
  "gray",
] as const;
export type NodeColor = (typeof NODE_COLORS)[number];

/** The color of a name; undefined for a name Duckpad has no tone for. */
export const nodeColor = (name: string | undefined) => {
  const color = appearanceName(name);
  return (NODE_COLORS as readonly string[]).includes(color)
    ? (color as NodeColor)
    : undefined;
};

export type AppearanceKey = "icon" | "color";
export const APPEARANCE_KEYS = ["icon", "color"] as const;
/** The names a node declares; a missing one leaves the default look. */
export type Appearance = Partial<Record<AppearanceKey, string>>;

/** Whether Duckpad can show the name declared for an icon or a color. */
export const knownAppearance = (key: AppearanceKey, name: string) =>
  key === "icon" ? !!nodeIcon(name) : !!nodeColor(name);

const ICON_NAMES = NODE_ICONS.map((choice) => choice.name);

/** Every valid name of an icon or a color. */
export const appearanceNames = (key: AppearanceKey): readonly string[] =>
  key === "icon" ? ICON_NAMES : NODE_COLORS;

/** What a definition declares, without the names Duckpad cannot show. */
export const appearanceOf = (
  definition: Pick<ParsedTemplate, "icon" | "color"> | undefined,
): { icon?: string; color?: NodeColor } => ({
  icon: nodeIcon(definition?.icon)?.name,
  color: nodeColor(definition?.color),
});

/**
 * What chooses a node's default icon: a component, Python, else the template
 * the node came from.
 */
export const nodeIconKind = (
  node: Pick<
    FlowNode,
    "component" | "language" | "preset" | "template" | "origin"
  >,
) =>
  node.component
    ? "component"
    : node.language === "python"
      ? "python"
      : node.preset || node.template || node.origin || "";

/** The tone of a declared color as a CSS value, where a class cannot give it. */
export const colorValue = (color: string | undefined) =>
  nodeColor(color) ? `var(${"--node-" + nodeColor(color)})` : undefined;

/** The classes that give a node, or its icon alone, the tones of its color. */
export const colorClass = (color: string | undefined) =>
  nodeColor(color) ? `node-colored node-color-${nodeColor(color)}` : "";

/** The name a misspelled or partial one most likely means. */
export function closestAppearance(key: AppearanceKey, name: string) {
  const typed = appearanceName(name);
  if (!typed) return undefined;
  const names = appearanceNames(key);
  return (
    names.find((known) => known.startsWith(typed) || typed.startsWith(known)) ??
    names.find((known) => known.includes(typed) || typed.includes(known)) ??
    names
      .map((known) => ({ known, distance: editDistance(typed, known) }))
      .filter(({ distance }) => distance <= 2)
      .sort((a, b) => a.distance - b.distance)[0]?.known
  );
}

/** How many edits turn one name into another; two swapped letters count once. */
function editDistance(a: string, b: string) {
  const rows = [Array.from({ length: b.length + 1 }, (_, index) => index)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        rows[i - 1][j] + 1,
        row[j - 1] + 1,
        rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
    }
    rows.push(row);
  }
  return rows[a.length][b.length];
}
