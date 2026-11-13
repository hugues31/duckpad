/**
 * What the code editor shows for `@icon` and `@color`: every name with a
 * preview of the icon or the tone it stands for, in SQL and in Python.
 */
import { createElement, Fragment } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { TranslationKey } from "./i18n";
import { colorValue, NODE_COLORS, type AppearanceKey } from "./nodeAppearance";
import {
  appearanceName,
  NODE_ICONS,
  nodeIcon,
  type NodeIconGroup,
} from "./nodeIcons";

export const ICON_GROUP_LABELS: Record<NodeIconGroup, TranslationKey> = {
  data: "iconGroupData",
  misc: "iconGroupMisc",
};

let drawn: Map<string, string> | null = null;
/** The SVG text of each icon, drawn once by its component. */
function drawings() {
  if (!drawn) {
    const host = document.createElement("div");
    const root = createRoot(host);
    flushSync(() =>
      root.render(
        createElement(
          Fragment,
          null,
          NODE_ICONS.map(({ name, Icon }) =>
            createElement(Icon, { key: name, size: 40, strokeWidth: 1.75 }),
          ),
        ),
      ),
    );
    drawn = new Map(
      NODE_ICONS.map(({ name }, index) => [
        name,
        host.children[index].outerHTML,
      ]),
    );
    root.unmount();
  }
  return drawn;
}

/** A color of the interface as `#rrggbb`, in the current theme. */
function resolved(value: string) {
  const probe = document.createElement("span");
  probe.style.color = value;
  document.body.append(probe);
  const channels = getComputedStyle(probe).color.match(/[\d.]+/g) ?? [];
  probe.remove();
  return (
    "#" +
    channels
      .slice(0, 3)
      .map((channel) =>
        Math.round(Number(channel)).toString(16).padStart(2, "0"),
      )
      .join("")
  );
}

/** The tone of a color name in the current theme, as `#rrggbb`. */
export const toneOf = (color: string | undefined) => {
  const value = colorValue(color);
  return value ? resolved(value) : undefined;
};

const image = (svg: string, alt: string) =>
  `![${alt}](data:image/svg+xml;base64,${btoa(svg)})`;

/**
 * Markdown showing the icon or the tone of a name, for suggestions or a hover.
 * Icons are drawn in the text color of the current theme, read once.
 */
export function appearancePreviews(key: AppearanceKey) {
  if (key === "color")
    return (name: string) => {
      const tone = toneOf(name);
      return tone
        ? image(
            `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="14" fill="${tone}"/></svg>`,
            name,
          )
        : "";
    };
  const ink = resolved("var(--text)");
  return (name: string) => {
    const choice = nodeIcon(name);
    const svg = choice && drawings().get(choice.name);
    return svg ? image(svg.replaceAll("currentColor", ink), choice.name) : "";
  };
}

export interface AppearanceSuggestion {
  name: string;
  /** Words that also find the name. */
  keywords: string;
  group?: NodeIconGroup;
  /** The tone of a color, shown beside its name. */
  tone?: string;
}

/**
 * The names `@icon` or `@color` accepts that the typed text finds, best first:
 * names that start with it, names that contain it, then names another word
 * finds, each in the order of the picker. A looser match, letter by letter
 * across those words, would offer `leaf` for `left`.
 */
export function appearanceSuggestions(
  key: AppearanceKey,
  typed = "",
): AppearanceSuggestion[] {
  const text = appearanceName(typed);
  const all: AppearanceSuggestion[] =
    key === "icon"
      ? NODE_ICONS.map(({ name, keywords, group }) => ({
          name,
          keywords,
          group,
        }))
      : NODE_COLORS.map((name) => ({ name, keywords: "" }));
  const rank = ({ name, keywords }: AppearanceSuggestion) =>
    name.startsWith(text)
      ? 0
      : name.includes(text)
        ? 1
        : keywords.split(" ").some((word) => word.startsWith(text))
          ? 2
          : 3;
  return all
    .map((suggestion) => ({ suggestion, rank: rank(suggestion) }))
    .filter(({ rank }) => rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .map(({ suggestion }) => suggestion);
}
