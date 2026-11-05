import { describe, expect, it } from "vitest";
import { projectFileLanguage, nodeFileLabel } from "./projectFiles";
import en from "./locales/en.json";
import { initialProjectFile } from "./projectFiles";
import type { Snapshot } from "./types";

it("opens the selected node source or the README, including component and linked nodes", () => {
  const snapshot = {
    files: {
      "README.md": "",
      "nodes/node_1.sql": "",
      "templates/shared.sql": "",
      "components/report/node_2.py": "",
      "components/report.json": "",
    },
    bundle: {
      flow: {
        nodes: [
          { id: "node_1" },
          { id: "linked", template: "shared" },
          { id: "report", component: "report" },
        ],
      },
      components: { report: { nodes: [{ id: "node_2", language: "python" }] } },
    },
  } as unknown as Snapshot;
  expect(initialProjectFile(snapshot, "")).toBe("README.md");
  expect(initialProjectFile(snapshot, "removed")).toBe("README.md");
  expect(initialProjectFile(snapshot, "node_1")).toBe("nodes/node_1.sql");
  expect(initialProjectFile(snapshot, "linked")).toBe("templates/shared.sql");
  expect(initialProjectFile(snapshot, "report")).toBe("components/report.json");
  expect(initialProjectFile(snapshot, "report::node_2")).toBe(
    "components/report/node_2.py",
  );
});

it("labels SQL and Python node files without exposing raw IDs", () => {
  const names = {
    node_1: [{ label: "Orders" }],
    "components/report/node_2": [{ label: "Report" }, { label: "Totals" }],
  };
  const t = (key: keyof typeof en) => en[key];
  expect(nodeFileLabel("nodes/node_1.sql", names, t)).toBe("Orders");
  expect(nodeFileLabel("components/report/node_2.py", names, t)).toBe("Totals");
  expect(nodeFileLabel("nodes/node_removed.sql", names, t)).toBe(en.node);
  expect(nodeFileLabel("templates/sql.sql", names, t)).toBeNull();
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
