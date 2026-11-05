import type { Project } from "./types";

export type ProjectSort = "modified" | "name" | "run";
export function projectList(
  projects: Project[],
  query: string,
  sort: ProjectSort,
) {
  const time = (project: Project) =>
    Date.parse(
      (sort === "run"
        ? project.last_run?.started
        : project.updated || project.created) || "",
    ) || 0;
  return projects
    .filter((project) =>
      project.name
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
    )
    .sort(
      (a, b) =>
        (sort === "name" ? 0 : time(b) - time(a)) ||
        a.name.localeCompare(b.name),
    );
}
