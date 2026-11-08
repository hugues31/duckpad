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
  const fold = (text: string) =>
    text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
  return projects
    .filter((project) => fold(project.name).includes(fold(query.trim())))
    .sort(
      (a, b) =>
        (sort === "name" ? 0 : time(b) - time(a)) ||
        a.name.localeCompare(b.name),
    );
}
