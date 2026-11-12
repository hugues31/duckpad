import { expect, it } from "vitest";
import { undefinedProperties } from "./check-css-properties.mjs";

it("checks stylesheets and inline styles against shared and dynamic definitions", () => {
  expect(
    undefinedProperties([
      ["tokens.css", ":root { --success: green; } /* --typo: red; */"],
      [
        "Graph.tsx",
        'style={{ "--height": "10px", stroke: "var(--success)", color: "var(--typo)" }}',
      ],
      ["graph.css", "height: var(--height); color: var(--danger, red);"],
    ]),
  ).toEqual([
    ["Graph.tsx", "--typo"],
    ["graph.css", "--danger"],
  ]);
});
