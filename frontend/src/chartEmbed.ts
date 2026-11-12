import enNumbers from "d3-format/locale/en-US";
import frNumbers from "d3-format/locale/fr-FR";
import ptNumbers from "d3-format/locale/pt-BR";
import enDates from "d3-time-format/locale/en-US";
import frDates from "d3-time-format/locale/fr-FR";
import ptDates from "d3-time-format/locale/pt-BR";
import type { Loader } from "vega";
import type { EmbedOptions, Result, VisualizationSpec } from "vega-embed";
import type { Config } from "vega-lite";
import type { ChartSpec } from "./charts";
import { ROW_ID, type ChartRow } from "./chartValues";
import type { Language, TranslationKey } from "./i18n";

/**
 * Number and date formats per interface language. Vega's locale is global, so
 * English sets en-US, Vega's default, back after another language.
 */
const LOCALES = {
  en: { formatLocale: enNumbers, timeFormatLocale: enDates },
  fr: { formatLocale: frNumbers, timeFormatLocale: frDates },
  pt: { formatLocale: ptNumbers, timeFormatLocale: ptDates },
} satisfies Record<
  Language,
  Pick<EmbedOptions, "formatLocale" | "timeFormatLocale">
>;

/** How a chart looks: the interface language and theme. */
export interface ChartAppearance {
  language: Language;
  config?: Config;
}

/** A base Vega-Lite config in the colors and font of the interface theme. */
export function themeConfig(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
): Config {
  const value = (name: string) => style.getPropertyValue(name).trim();
  const text = value("--text");
  const muted = value("--muted");
  const border = value("--border");
  return {
    background: "transparent",
    font: value("font-family"),
    mark: { color: value("--accent") },
    axis: {
      domainColor: border,
      gridColor: border,
      tickColor: border,
      labelColor: muted,
      titleColor: text,
    },
    legend: { labelColor: muted, titleColor: text },
    title: { color: text, subtitleColor: muted },
    view: { stroke: border },
  };
}

/** The translation key of the error a refused load rejects with. */
export const LOAD_REFUSED = "chartLoadRefused" satisfies TranslationKey;

const refuse = () => Promise.reject(new Error(LOAD_REFUSED));

/** A Vega loader that rejects every request: a chart only draws the rows Duckpad supplies. */
const blockingLoader: Loader = {
  load: refuse,
  sanitize: refuse,
  http: refuse,
  file: refuse,
};

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
const escapeHTML = (value: unknown) =>
  String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
const tooltipText = (value: unknown) =>
  escapeHTML(
    value !== null && typeof value === "object" ? JSON.stringify(value) : value,
  );

/**
 * Tooltip HTML made of escaped text only. vega-tooltip's default turns an
 * `image` entry into an `<img>` whose source is a cell, escaped for `&` and
 * `<` alone: the cell could close the attribute or load a remote image.
 */
export function formatTooltip(value: unknown) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return tooltipText(value);
  const rows = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(
      ([key, item]) =>
        `<tr><td class="key">${escapeHTML(key)}</td><td class="value">${tooltipText(item)}</td></tr>`,
    );
  return `<table>${rows.join("")}</table>`;
}

/**
 * Embed options that always parse the spec as Vega-Lite, never as Vega, and
 * never generate code or reach the network: expressions
 * run in `vega-interpreter` (`ast: true`), every load is refused, tooltips
 * are text and the actions menu, which can open the spec in an online
 * editor, is hidden.
 */
export function embedOptions(
  expr: NonNullable<EmbedOptions["expr"]>,
  { language, config }: ChartAppearance = { language: "en" },
) {
  return {
    mode: "vega-lite",
    ast: true,
    expr,
    loader: blockingLoader,
    tooltip: { formatTooltip },
    actions: false,
    renderer: "svg",
    config,
    ...LOCALES[language],
  } satisfies EmbedOptions;
}

/** The spec drawn: the rows as its `data` and the container width unless it sets one. */
export function chartSpec(spec: ChartSpec, rows: ChartRow[]): ChartSpec {
  // `usermeta.embedOptions` would override the embed options above.
  const { usermeta: _, ...drawn } = spec;
  // Vega-Lite's path escaping does not round-trip every quote/backslash combination.
  // Compile only generated identifiers; original names remain display titles.
  const fields = new Map<string, string>();
  const fieldName = (field: string) => {
    if (!fields.has(field)) fields.set(field, `column_${fields.size}`);
    return fields.get(field)!;
  };
  const rendered = literalFields(drawn, fieldName);
  return {
    width: "container",
    ...rendered,
    data: {
      name: "data",
      values: rows.map((row) => ({
        ...Object.fromEntries(
          [...fields].map(([field, alias]) => [alias, row[field]]),
        ),
        [ROW_ID]: row[ROW_ID],
      })),
    },
  };
}

/** Give flat column names internal identifiers in the rendered spec only. */
function literalFields(
  spec: ChartSpec,
  fieldName: (field: string) => string,
): ChartSpec {
  const definition = (name: string, value: unknown): unknown => {
    if (Array.isArray(value))
      return value.map((item) => definition(name, item));
    if (!value || typeof value !== "object") return value;
    const channel = value as Record<string, unknown>;
    if (typeof channel.field !== "string") return channel;
    const title = channel.title === undefined ? channel.field : channel.title;
    const guide = ["x", "y"].includes(name)
      ? "axis"
      : [
            "color",
            "fill",
            "stroke",
            "opacity",
            "size",
            "shape",
            "strokeDash",
          ].includes(name)
        ? "legend"
        : null;
    // Vega-Lite quotes tooltip/ARIA titles but fails to escape backslashes and
    // line breaks. Quotes themselves are escaped by the compiler.
    const escaped = String(title || channel.field)
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return {
      ...channel,
      field: fieldName(channel.field),
      title: escaped,
      // The guide shows the original title only where it differs: otherwise
      // Vega-Lite still merges the titles of x and x2 ("start, end").
      ...(guide &&
        escaped !== title &&
        channel[guide] !== null && {
          [guide]: { title, ...(channel[guide] as object | undefined) },
        }),
    };
  };
  return {
    ...spec,
    ...(spec.encoding
      ? {
          encoding: Object.fromEntries(
            Object.entries(spec.encoding).map(([name, value]) => [
              name,
              definition(name, value),
            ]),
          ),
        }
      : {}),
    ...(Array.isArray(spec.layer) && {
      layer: spec.layer.map((layer) => literalFields(layer, fieldName)),
    }),
  };
}

/**
 * Draw a chart, loading Vega on first use so the main bundle stays small.
 * An aborted signal stops it before it draws into the element.
 */
export async function renderChart(
  element: HTMLElement,
  spec: ChartSpec,
  rows: ChartRow[],
  appearance?: ChartAppearance,
  signal?: AbortSignal,
): Promise<Result> {
  const [{ default: embed }, { expressionInterpreter }] = await Promise.all([
    import("vega-embed"),
    import("vega-interpreter"),
  ]);
  signal?.throwIfAborted();
  return embed(
    element,
    chartSpec(spec, rows) as VisualizationSpec,
    embedOptions(expressionInterpreter, appearance),
  );
}
