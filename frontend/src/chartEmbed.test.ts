// @vitest-environment happy-dom
import type { Item, TooltipHandler } from "vega";
import { expressionInterpreter } from "vega-interpreter";
import { expect, it } from "vitest";
import {
  chartSpec,
  embedOptions,
  formatTooltip,
  LOAD_REFUSED,
  renderChart,
  themeConfig,
} from "./chartEmbed";
import { chartRows } from "./chartValues";

const BARS = {
  mark: "bar",
  encoding: { x: { field: "region" }, y: { field: "revenue" } },
};

it("embeds with the expression interpreter, no actions and an SVG renderer", () => {
  const options = embedOptions(expressionInterpreter);
  expect(options.ast).toBe(true);
  expect(options.expr).toBe(expressionInterpreter);
  expect(options.actions).toBe(false);
  expect(options.renderer).toBe("svg");
});

it("parses every spec as Vega-Lite, even one without mark, layer or encoding", () => {
  expect(embedOptions(expressionInterpreter).mode).toBe("vega-lite");
});

it("refuses every network and file request", async () => {
  const { loader } = embedOptions(expressionInterpreter);
  // The error is a translation key: the Chart tab shows it in the interface language.
  await expect(loader.load("https://example.com/data.csv")).rejects.toThrow(
    LOAD_REFUSED,
  );
  await expect(loader.load("data.csv")).rejects.toThrow();
  await expect(
    loader.sanitize("https://example.com/a.png", { context: "image" }),
  ).rejects.toThrow();
  await expect(loader.http("https://example.com/", {})).rejects.toThrow();
  await expect(loader.file("/etc/passwd")).rejects.toThrow();
});

// A cell is untrusted text: vega-tooltip's default formatter would turn this
// one, under an `image` key, into <img src="x:a" onerror="alert(1)">.
const ATTACK = 'x:a" onerror="alert(1)';

it("formats tooltips as escaped text, with no image", () => {
  const html = formatTooltip({ image: ATTACK, title: "<b>", amount: 3 });
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<b>");
  expect(html).toContain("x:a&quot; onerror=&quot;alert(1)");
  expect(formatTooltip([ATTACK, { a: "<" }])).toBe(
    "[&quot;x:a\\&quot; onerror=\\&quot;alert(1)&quot;,{&quot;a&quot;:&quot;&lt;&quot;}]",
  );
  expect(formatTooltip("<svg onload=alert(1)>")).toBe(
    "&lt;svg onload=alert(1)&gt;",
  );
});

it("shows a hovered cell in the tooltip as text", async () => {
  const element = document.createElement("div");
  document.body.append(element);
  const rows = chartRows(
    [{ name: "image", type: "VARCHAR" }],
    [{ id: 0, values: [ATTACK] }],
  );
  const result = await renderChart(
    element,
    {
      mark: { type: "point", tooltip: true },
      encoding: { x: { field: "image", type: "nominal" } },
    },
    rows,
  );
  // Vega's getter, which its typings omit, returns the handler embed installed.
  const view = result.view as unknown as { tooltip(): TooltipHandler };
  view.tooltip()(result.view, new MouseEvent("mousemove"), {} as Item, {
    image: ATTACK,
  });
  const tooltip = document.getElementById("vg-tooltip-element");
  expect(tooltip?.querySelector("img")).toBeNull();
  expect(tooltip?.textContent).toContain(ATTACK);
  result.finalize();
  element.remove();
});

it("draws nothing once its signal is aborted", async () => {
  const element = document.createElement("div");
  const drawing = new AbortController();
  const rendered = renderChart(element, BARS, [], undefined, drawing.signal);
  drawing.abort();
  await expect(rendered).rejects.toThrow();
  expect(element.childNodes).toHaveLength(0);
});

it("fills the container width unless the spec sets one", () => {
  expect(chartSpec(BARS, []).width).toBe("container");
  expect(chartSpec({ ...BARS, width: 320 }, []).width).toBe(320);
});

it("supplies the rows as the spec's data and drops embed options from the spec", () => {
  const rows = chartRows(
    [
      { name: "region", type: "VARCHAR" },
      { name: "revenue", type: "INTEGER" },
    ],
    [{ id: 0, values: ["North", 3] }],
  );
  const spec = chartSpec(
    {
      ...BARS,
      data: { name: "data" },
      usermeta: { embedOptions: { ast: false } },
    },
    rows,
  );
  expect(spec.data).toEqual({ name: "data", values: rows });
  expect(spec).not.toHaveProperty("usermeta");
});

// Vega's locale is global: English sets it back to Vega's default, en-US.
it.each([
  ["en", ".", ",", "%-m/%-d/%Y"],
  ["fr", ",", " ", "%d/%m/%Y"],
  ["pt", ",", ".", "%d/%m/%Y"],
] as const)(
  "formats numbers and dates in the %s interface language",
  (language, decimal, thousands, date) => {
    const options = embedOptions(expressionInterpreter, { language });
    expect(options.formatLocale).toMatchObject({ decimal, thousands });
    expect(options.timeFormatLocale).toMatchObject({ date });
  },
);

it("derives the chart theme from the interface's CSS variables", () => {
  const variables: Record<string, string> = {
    "--text": " #16161b",
    "--muted": "#191b22",
    "--border": "#71717a40",
    "--accent": "#1559df",
    "font-family": "Inter, sans-serif",
  };
  const config = themeConfig({
    getPropertyValue: (name) => variables[name] ?? "",
  });
  expect(config).toEqual({
    background: "transparent",
    font: "Inter, sans-serif",
    mark: { color: "#1559df" },
    axis: {
      domainColor: "#71717a40",
      gridColor: "#71717a40",
      tickColor: "#71717a40",
      labelColor: "#191b22",
      titleColor: "#16161b",
    },
    legend: { labelColor: "#191b22", titleColor: "#16161b" },
    title: { color: "#16161b", subtitleColor: "#191b22" },
    view: { stroke: "#71717a40" },
  });
  expect(
    embedOptions(expressionInterpreter, { language: "en", config }).config,
  ).toBe(config);
});
