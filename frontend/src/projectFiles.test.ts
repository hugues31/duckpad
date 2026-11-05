import { describe, expect, it } from "vitest";
import { projectFileLanguage, projectFileLabel } from "./projectFiles";
import en from "./locales/en.json";

it("labels SQL and Python node files without exposing raw IDs", () => {
  const names = {
    node_1: [{ label: "Orders" }],
    "components/report/node_2": [{ label: "Report" }, { label: "Totals" }],
  };
  const t = (key: keyof typeof en) => en[key];
  expect(projectFileLabel("nodes/node_1.sql", names, t)).toBe("Orders");
  expect(projectFileLabel("components/report/node_2.py", names, t)).toBe(
    "Report / Totals",
  );
  expect(projectFileLabel("nodes/node_removed.sql", names, t)).toBe(en.node);
  expect(projectFileLabel("templates/sql.sql", names, t)).toBe("sql.sql");
});

describe("projectFileLanguage", () => {
  it("highlights SQL templates as SQL", () => {
    expect(projectFileLanguage("templates/clean_orders.sql")).toBe("sql");
  });

  it("highlights documentation as Markdown", () => {
    expect(projectFileLanguage("README.md")).toBe("markdown");
    expect(projectFileLanguage("docs/nodes/orders.md")).toBe("markdown");
  });

  it("highlights TOML files with the INI tokenizer", () => {
    expect(projectFileLanguage("pyproject.toml")).toBe("ini");
  });

  it("falls back to JSON for other files", () => {
    expect(projectFileLanguage("flow.json")).toBe("json");
    expect(projectFileLanguage("components/enrich.json")).toBe("json");
    expect(projectFileLanguage("LICENSE")).toBe("json");
  });

  it("uses the final extension only", () => {
    expect(projectFileLanguage("notes.sql.md")).toBe("markdown");
    expect(projectFileLanguage("query.md.sql")).toBe("sql");
  });
});
