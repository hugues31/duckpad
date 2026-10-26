import {
  ArrowRight,
  FolderOpen,
  Layers,
  Loader2,
  Play,
  Plus,
} from "lucide-react";
import { useT, type Language } from "./i18n";
import type { Project } from "./types";

export default function ProjectDashboard({
  projects,
  language,
  busy,
  onOpen,
  onCreate,
  onExample,
}: {
  projects: Project[];
  language: Language;
  busy: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onExample: () => void;
}) {
  const t = useT();
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
        {projects.length ? (
          <ul className="project-grid" aria-label={t("projects")}>
            {projects.map((project) => (
              <li key={project.id}>
                <button
                  className="project-card"
                  aria-label={`${t("openProject")}: ${project.name}`}
                  onClick={() => onOpen(project.main)}
                >
                  <span className="project-card-icon">
                    <Layers size={22} />
                  </span>
                  <strong>{project.name}</strong>
                  <span className="project-card-date">
                    {t("createdOn")}{" "}
                    {dateFormat.format(new Date(project.created))}
                  </span>
                  <span className="project-card-action">
                    {t("openProject")}
                    <ArrowRight size={16} />
                  </span>
                </button>
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
