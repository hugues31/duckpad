import { describe, expect, it } from "vitest";
import { projectFileLanguage } from "./projectFiles";

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
