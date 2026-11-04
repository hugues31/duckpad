import { describe, expect, it } from "vitest";
import {
  changedCharacters,
  combinedFiles,
  conflictDrafts,
  conflictPath,
  conflictTitle,
} from "./conflicts";
import en from "./locales/en.json";
import type { Conflict, Json } from "./types";
import type { MergeConflict } from "./gitTypes";
import type { Translate } from "./i18n";

const t: Translate = (key) => en[key];
const value = (value: Json, present = true) => ({ value, present });
const field = (path: string, incoming: Json): MergeConflict => ({
  path,
  choice: null,
  base: value("base"),
  current: value("saved"),
  incoming: value(incoming),
});
const conflict = (
  fields: MergeConflict[],
  merged: Record<string, string>,
): Conflict => ({
  id: "review",
  revision: "revision",
  paths: fields.map((f) => f.path),
  fields,
  merged,
  base: {},
  current: {},
  proposal: {},
});

describe("conflict content", () => {
  it("patches semantic node IDs and escaped keys while preserving independent changes", () => {
    const path = "flow.json/nodes/filter/params/a~1b";
    const review = conflict([field(path, "incoming")], {
      "flow.json": JSON.stringify({
        nodes: [
          { id: "other" },
          {
            id: "filter",
            label: "Saved label",
            params: { "a/b": "incoming", independent: 42 },
          },
        ],
      }),
      "README.md": "Saved docs",
    });
    const drafts = conflictDrafts(review);
    drafts[path].text = "combined";
    const result = combinedFiles(review, drafts);
    expect(JSON.parse(result["flow.json"]).nodes[1]).toEqual({
      id: "filter",
      label: "Saved label",
      params: { "a/b": "combined", independent: 42 },
    });
    expect(result["README.md"]).toBe("Saved docs");
    expect(JSON.parse(review.merged["flow.json"]).nodes[1].params["a/b"]).toBe(
      "incoming",
    );
  });

  it("preserves numeric, null and empty values and rejects malformed JSON", () => {
    const review = conflict([field("variables.json/count/default", 3)], {
      "variables.json": '{"count":{"default":3}}',
    });
    const drafts = conflictDrafts(review);
    drafts[review.paths[0]].text = "false";
    expect(
      JSON.parse(combinedFiles(review, drafts)["variables.json"]).count.default,
    ).toBe(false);
    drafts[review.paths[0]].text = "null";
    expect(
      JSON.parse(combinedFiles(review, drafts)["variables.json"]).count.default,
    ).toBeNull();
    drafts[review.paths[0]].text = "invalid";
    expect(() => combinedFiles(review, drafts)).toThrow();
  });

  it("deletes only a selected file or field and locates shared views by name", () => {
    const review = conflict(
      [
        field("README.md", "note"),
        field("views.json/report:result/My~1view/limit", 30),
      ],
      {
        "README.md": "note",
        "views.json":
          '{"report:result":[{"name":"My/view","limit":30,"sort":[]}]}',
      },
    );
    const drafts = conflictDrafts(review);
    drafts["README.md"].present = false;
    drafts[review.paths[1]].text = "50";
    const result = combinedFiles(review, drafts);
    expect(result).not.toHaveProperty("README.md");
    expect(JSON.parse(result["views.json"])["report:result"][0]).toEqual({
      name: "My/view",
      limit: 50,
      sort: [],
    });
    drafts[review.paths[1]].present = false;
    expect(
      JSON.parse(combinedFiles(review, drafts)["views.json"])[
        "report:result"
      ][0],
    ).not.toHaveProperty("limit");
  });

  it("names nodes, component nodes and variables with raw paths only as fallback", () => {
    const files = {
      "flow.json": '{"nodes":[{"id":"report","label":"Revenue report"}]}',
      "components/nested.json":
        '{"name":"Nested","nodes":[{"id":"filter","template":"filter"}]}',
      "templates/filter.sql": "-- @label Filter\nSELECT 1;",
    };
    expect(conflictTitle("nodes/report.sql", t, [files])).toBe(
      "Revenue report · SQL",
    );
    expect(
      conflictTitle("components/nested.json/nodes/filter/params/condition", t, [
        files,
      ]),
    ).toBe("Filter · condition");
    expect(conflictTitle("variables.json/status/default", t, [files])).toBe(
      "Variable status · Default value",
    );
    expect(
      conflictTitle("flow.json/nodes/report/params/minimum", t, [
        { "flow.json": "{" },
        files,
      ]),
    ).toBe("Revenue report · minimum");
    expect(conflictPath("components/nested/filter.sql")).toEqual({
      file: "components/nested/filter.sql",
      parts: [],
    });
  });

  it("names Python nodes by their label comment or class", () => {
    const files = {
      "flow.json": JSON.stringify({
        nodes: [
          { id: "split", language: "python" },
          { id: "labeled", language: "python" },
        ],
      }),
      "nodes/split.py":
        "import duckpad as dp\n\n\nclass Split(dp.Node):\n    pass\n",
      "nodes/labeled.py":
        "# @label Revenue split\nimport duckpad as dp\n\n\nclass Split(dp.Node):\n    pass\n",
      "modules/helpers.py": "class Helper(Base):\n    pass\n",
    };
    expect(conflictTitle("nodes/split.py", t, [files])).toBe("Split · Code");
    expect(conflictTitle("nodes/labeled.py", t, [files])).toBe(
      "Revenue split · Code",
    );
    expect(
      conflictTitle("flow.json/nodes/labeled/params/minimum", t, [files]),
    ).toBe("Revenue split · minimum");
    expect(conflictTitle("modules/helpers.py", t, [files])).toBe("helpers.py");
  });

  it("uses shared names and component paths in conflict headings", () => {
    const names = {
      report: [{ label: "Revenue report", template: "sql" }],
      filter: [{ label: "Filter", template: "filter" }],
      "components/nested/filter": [
        { label: "Reporting" },
        { label: "Filter", template: "filter" },
      ],
    };
    const title = (path: string) => conflictTitle(path, t, [], [], names);
    expect(title("nodes/report.sql")).toBe("Revenue report · SQL");
    expect(title("flow.json/nodes/filter/params/condition")).toBe(
      "Filter · condition",
    );
    expect(title("components/nested.json/nodes/filter/params/condition")).toBe(
      "Reporting / Filter · condition",
    );
    expect(title("components/nested/filter.sql")).toBe(
      "Reporting / Filter · SQL",
    );
    expect(title("flow.json/nodes/unknown/label")).toBe("unknown · label");
  });
});

it("highlights separate character changes without marking unchanged text", () => {
  const before = "status = 'paid' AND total > 100";
  const after = "status = 'held' AND total > 200";
  const [removed, added] = changedCharacters(before, after);
  expect([...removed].map((i) => before[i]).join("")).toBe("pai1");
  expect([...added].map((i) => after[i]).join("")).toBe("hel2");
  expect(changedCharacters("", "")).toEqual([new Set(), new Set()]);
  expect(changedCharacters("a".repeat(2000), "b".repeat(2000))[0].size).toBe(
    2000,
  );
});
