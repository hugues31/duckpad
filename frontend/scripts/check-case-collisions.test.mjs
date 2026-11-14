import { expect, it } from "vitest";
import { caseCollisions } from "./check-case-collisions.mjs";

it("reports names that differ only in case, ignoring module extensions", () => {
  expect(
    caseCollisions([
      "src/Panel.tsx",
      "src/panel.ts",
      "src/panel.test.ts",
      "src/types.ts",
      "src/types.d.ts",
      "src/Logo.svg",
      "src/logo.svg",
      "src/theme.css",
      "src/Theme.tsx",
    ]),
  ).toEqual([
    ["src/Panel.tsx", "src/panel.ts"],
    ["src/Logo.svg", "src/logo.svg"],
  ]);
});
