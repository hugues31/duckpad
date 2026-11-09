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
import type { ChartRow } from "./chartValues";
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
  return {
    width: "container",
    ...drawn,
    data: { name: "data", values: rows },
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
