import { expect, it } from "vitest";
import { projectList } from "./projectList";
import type { Project } from "./types";

it("filters names and sorts modification dates and last runs without changing workspace order", () => {
  const projects = [
    {
      id: "1",
      name: "Alpha",
      created: "2026-01-01",
      updated: "2026-01-02T10:00:00+02:00",
    },
    {
      id: "2",
      name: "Beta",
      created: "2026-01-01",
      updated: "2026-01-02T09:00:00Z",
    },
    {
      id: "3",
      name: "Gamma",
      created: "2026-01-01",
      last_run: { started: "2026-01-03" },
    },
  ] as Project[];
  expect(projectList(projects, " ALP ", "name").map((p) => p.id)).toEqual([
    "1",
  ]);
  expect(
    projectList([{ ...projects[0], name: "Émile" }], "emile", "name"),
  ).toHaveLength(1);
  expect(projectList(projects, "", "modified").map((p) => p.id)).toEqual([
    "2",
    "1",
    "3",
  ]);
  expect(projectList(projects, "", "run").map((p) => p.id)).toEqual([
    "3",
    "1",
    "2",
  ]);
  expect(projectList(projects, "", "name").map((p) => p.id)).toEqual([
    "1",
    "2",
    "3",
  ]);
  expect(projects.map((p) => p.id)).toEqual(["1", "2", "3"]);
  expect(projectList(projects, "absent", "name")).toEqual([]);
});
