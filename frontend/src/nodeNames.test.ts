import { expect, it } from "vitest";
import { displayNodeName, type NodeNames } from "./nodeNames";
import en from "./locales/en.json";
import fr from "./locales/fr.json";
import type { Translate } from "./i18n";

const t: Translate = (key) => en[key];
const names: NodeNames = {
  node_report: [{ label: "Revenue report", template: "sql" }],
  node_filter: [{ label: "Filter", template: "filter" }],
  "components/summary/node_filter": [
    { label: "Summary" },
    { label: "Filter", template: "filter" },
  ],
};

it("uses the shared names and translates only built-in defaults", () => {
  expect(displayNodeName(names.node_report, "node_report", t)).toBe(
    "Revenue report",
  );
  expect(
    displayNodeName(names.node_filter, "node_filter", (key) => fr[key]),
  ).toBe(fr.filter);
  expect(displayNodeName([{ label: "Filter" }], "id", (key) => fr[key])).toBe(
    "Filter",
  );
  expect(
    displayNodeName(names["components/summary/node_filter"], "id", t),
  ).toBe("Summary / Filter");
  expect(displayNodeName(undefined, "removed_node", t)).toBe("removed_node");
});
