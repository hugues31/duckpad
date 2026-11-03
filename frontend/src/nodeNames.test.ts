import { expect, it } from "vitest";
import { displayNodeName, type NodeNames } from "./nodeNames";
import { conflictLabel } from "./variables";
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

it("names SQL and parameter conflicts without changing their stable paths", () => {
  expect(conflictLabel("nodes/node_report.sql", t, names)).toBe(
    "Revenue report · SQL",
  );
  expect(
    conflictLabel("flow.json/nodes/node_filter/params/condition", t, names),
  ).toBe("Filter · condition");
  expect(
    conflictLabel(
      "components/summary.json/nodes/node_filter/params/condition",
      t,
      names,
    ),
  ).toBe("Summary / Filter · condition");
  expect(conflictLabel("components/summary/node_filter.sql", t, names)).toBe(
    "Summary / Filter · SQL",
  );
  expect(conflictLabel("variables.json/minimum/default", t, names)).toBe(
    "Variable minimum · Default value",
  );
  expect(conflictLabel("flow.json/nodes/unknown/label", t, names)).toBeNull();
});
