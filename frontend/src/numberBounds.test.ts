import { expect, it } from "vitest";
import type { Translate } from "./i18n";
import en from "./locales/en.json";
import { numberBounds, numberBoundsError } from "./numberBounds";

const t: Translate = (key) => en[key];

it("formats declared bounds with comparison symbols", () => {
  expect(numberBounds({ ge: 0, lt: 10 })).toEqual(["≥ 0", "< 10"]);
  expect(numberBounds({ gt: -1.5, le: 2 })).toEqual(["> -1.5", "≤ 2"]);
  expect(numberBounds({})).toEqual([]);
});

it("accepts values within inclusive and exclusive bounds", () => {
  const limits = { python_type: "int", ge: 0, lt: 10 };
  expect(numberBoundsError(0, limits, t)).toBe("");
  expect(numberBoundsError(9, limits, t)).toBe("");
  expect(numberBoundsError(2.5, { gt: 2, le: 3 }, t)).toBe("");
});

it("explains integer and bound violations", () => {
  const limits = { python_type: "int", ge: 0, lt: 10 };
  expect(numberBoundsError(2.5, limits, t)).toBe(en.invalidInteger);
  expect(numberBoundsError(10, limits, t)).toBe(
    "The value must satisfy: ≥ 0, < 10",
  );
  expect(numberBoundsError(-1, limits, t)).toBe(
    "The value must satisfy: ≥ 0, < 10",
  );
  expect(numberBoundsError(2, { gt: 2 }, t)).toBe(
    "The value must satisfy: > 2",
  );
  expect(numberBoundsError(3.5, { python_type: "float", le: 3 }, t)).toBe(
    "The value must satisfy: ≤ 3",
  );
});
