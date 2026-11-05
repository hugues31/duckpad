import { Link } from "react-router";
import { worktreeUrl } from "./navigation";
import {
  ArrowRight,
  FolderOpen,
  Layers,
  Loader2,
  Play,
  Plus,
} from "lucide-react";
import { useLanguage, useT } from "./i18n";
import type { Project } from "./types";
import { useState } from "react";
import Select from "./Select";
import { projectList, type ProjectSort } from "./projectList";

/** Search and sort appear once the projects no longer fit at a glance. */
const SEARCH_FROM = 7;

export default function ProjectDashboard({
  projects,
  busy,
  onCreate,
  onExample,
  activityError,
}: {
  projects: Project[];
  busy: boolean;
  onCreate: () => void;
  onExample: () => void;
  activityError?: string;
}) {
  const t = useT();
  const language = useLanguage();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>("modified");
  const visible = projectList(projects, query, sort);
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: "medium" });
  return (
    <main className="project-dashboard" aria-labelledby="projects-heading">
      <div className="dashboard-content">
        <header className="dashboard-heading">
          <div>
            <span className="eyebrow">{t("workspace")}</span>
            <h1 id="projects-heading">{t("projects")}</h1>
            <p>{t("projectsDescription")}</p>
          </div>
          <button className="button primary" onClick={onCreate}>
            <Plus size={17} />
            {t("newProject")}
          </button>
        </header>
        {activityError && (
          <p className="notice error" role="alert">
            {activityError}
          </p>
        )}
        {projects.length >= SEARCH_FROM && (
          <div className="project-dashboard-tools">
            <input
              type="search"
              aria-label={t("searchProjects")}
              placeholder={t("searchProjects")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Select
              aria-label={t("sortProjects")}
              value={sort}
              onChange={(event) => setSort(event.target.value as ProjectSort)}
            >
              <option value="modified">{t("lastModified")}</option>
              <option value="name">{t("name")}</option>
              <option value="run">{t("projectLastRun")}</option>
            </Select>
          </div>
        )}
        {!!projects.length && !visible.length && (
          <p className="empty-state">{t("noSearchResults")}</p>
        )}
        {projects.length ? (
          <ul className="project-grid" aria-label={t("projects")}>
            {visible.map((project) => (
              <li key={project.id}>
                <Link
                  to={worktreeUrl(project.main)}
                  className="project-card"
                  aria-label={`${t("openProject")}: ${project.name}`}
                >
                  <span className="project-card-icon">
                    <Layers size={22} />
                  </span>
                  <strong>{project.name}</strong>
                  <span className="project-card-date">
                    {t(project.updated ? "lastModified" : "createdOn")}{" "}
                    <time dateTime={project.updated || project.created}>
                      {dateFormat.format(
                        new Date(project.updated || project.created),
                      )}
                    </time>
                  </span>
                  {/* Undefined until the activity request answers. */}
                  {project.last_run !== undefined && (
                    <span className="project-card-date">
                      {t("projectLastRun")}:{" "}
                      {project.last_run ? (
                        <>
                          <span className={`badge ${project.last_run.status}`}>
                            {t(project.last_run.status)}
                          </span>{" "}
                          · {project.last_run.environment} ·{" "}
                          <time dateTime={project.last_run.started}>
                            {dateFormat.format(
                              new Date(project.last_run.started),
                            )}
                          </time>
                        </>
                      ) : (
                        "—"
                      )}
                    </span>
                  )}
                  <span className="project-card-action">
                    {t("openProject")}
                    <ArrowRight size={16} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <section className="dashboard-empty">
            <FolderOpen size={42} />
            <h2>{t("noProjects")}</h2>
            <p>{t("noProjectsDescription")}</p>
            <button
              className="button secondary"
              onClick={onExample}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="spin" size={17} />
              ) : (
                <Play size={16} />
              )}
              {t("example")}
            </button>
            <p className="dashboard-example-note">{t("exampleDescription")}</p>
          </section>
        )}
      </div>
    </main>
  );
}
