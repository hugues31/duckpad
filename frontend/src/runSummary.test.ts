import { expect, it } from "vitest";
import en from "./locales/en.json";
import { keptSummary } from "./runSummary";
import type { TranslationKey } from "./i18n";
import type { Run } from "./types";

const t = (key: TranslationKey) => en[key];
const run = (nodes: Record<string, object>, values: object = {}) =>
  ({ status: "success", scope: "project", nodes, ...values }) as Run;
const kept = { status: "success", kept: { run: "first", created: "" } };
const computed = { status: "success" };

it("says what a run of the flow kept and computed", () => {
  expect(keptSummary(run({ a: kept, b: kept, c: computed }), t)).toBe(
    "1 node run · 2 results kept",
  );
  expect(keptSummary(run({ a: kept, b: computed, c: computed }), t)).toBe(
    "2 nodes run · 1 result kept",
  );
  expect(keptSummary(run({ a: kept, b: kept }), t)).toBe(
    "Nothing to run: every result is valid",
  );
});

it("stays silent when nothing was kept, for a node and after a failure", () => {
  expect(keptSummary(run({ a: computed }), t)).toBe("");
  expect(keptSummary(run({ a: kept, b: computed }, { scope: "b" }), t)).toBe(
    "",
  );
  expect(
    keptSummary(run({ a: kept, b: computed }, { status: "failed" }), t),
  ).toBe("");
});
