import Select from "./Select";
import {
  GitBranch,
  HelpCircle,
  Layers,
  Plus,
  Workflow,
  Settings2,
} from "lucide-react";
import AccountMenu from "./AccountMenu";
import DuckMark from "./DuckMark";
import GitSyncButton from "./GitSyncButton";
import { useT } from "./i18n";
import type { Preferences } from "./preferences";
import ResourceMonitor from "./ResourceMonitor";
import type { Snapshot, Workspace } from "./types";

export type Area =
  | "projects"
  | "pipelines"
  | "instanceSettings"
  | "userSettings"
  | "projectSettings";

const RAIL = [
  ["pipelines", Workflow],
  ["instanceSettings", Settings2],
] as const;

export default function TopBar({
  area,
  workspace,
  worktree,
  snapshot,
  environment,
  preferences,
  onArea,
  onHome,
  onHelp,
  onOpenProject,
  onNewProject,
  onWorktree,
  onNewBranch,
  onGit,
  gitVersion,
  onEnvironment,
  onSignOut,
}: {
  area: Area;
  workspace: Workspace | null;
  worktree: string;
  snapshot: Snapshot | null;
  environment: string;
  preferences: Preferences;
  onArea: (area: Area) => void;
  onHome: () => void;
  onHelp: () => void;
  onOpenProject: (worktree: string) => void;
  onNewProject: () => void;
  onWorktree: (worktree: string) => void;
  onNewBranch: () => void;
  onGit: () => void;
  gitVersion: number;
  onEnvironment: (environment: string) => void;
  onSignOut: () => void;
}) {
  const t = useT();
  const instanceAdmin = workspace?.user.role === "admin";
  const canEdit = snapshot?.role === "admin" || snapshot?.role === "editor";
  const projectArea = area === "pipelines" || area === "projectSettings";
  return (
    <header className="topbar">
      <nav className="rail" aria-label={t("workspace")}>
        <button
          className="brand-button"
          title="Duckpad"
          aria-label={t("backToProjects")}
          aria-current={area === "projects" ? "page" : undefined}
          onClick={onHome}
        >
          <DuckMark size={30} />
        </button>
        <div className="rail-main">
          {RAIL.filter(([key]) => key === "pipelines" || instanceAdmin).map(
            ([key, Icon]) => (
              <button
                key={key}
                className={`rail-button ${area === key ? "active" : ""}`}
                title={t(key)}
                aria-label={t(key)}
                aria-current={area === key ? "page" : undefined}
                onClick={() => onArea(key)}
              >
                <Icon size={21} />
              </button>
            ),
          )}
        </div>
        <button className="rail-button" title={t("help")} onClick={onHelp}>
          <HelpCircle size={20} />
        </button>
      </nav>
      {!projectArea ? (
        <div className="dashboard-brand">Duckpad</div>
      ) : (
        <div className="project-picker">
          <span className="project-symbol">
            <Layers size={18} />
          </span>
          <div>
            <span className="eyebrow">{t("workspace")}</span>
            <Select
              aria-label={t("activeProject")}
              value={
                snapshot?.worktree.project ||
                workspace?.worktrees.find((w) => w.id === worktree)?.project ||
                ""
              }
              onChange={(e) => {
                const project = workspace?.projects.find(
                  (p) => p.id === e.target.value,
                );
                if (project) onOpenProject(project.main);
              }}
            >
              {!workspace?.projects.length && <option>Duckpad</option>}
              {workspace?.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <button
            className="icon"
            title={t("newProject")}
            onClick={onNewProject}
          >
            <Plus size={16} />
          </button>
        </div>
      )}
      <div className="topbar-right">
        {snapshot && area === "pipelines" && (
          <>
            <div className="branch-picker">
              <GitBranch size={14} />
              <Select
                aria-label={t("branch")}
                value={worktree}
                onChange={(e) => onWorktree(e.target.value)}
              >
                {workspace?.worktrees
                  .filter((w) => w.project === snapshot.worktree.project)
                  .map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.branch}
                    </option>
                  ))}
              </Select>
              <button
                className="icon"
                title={t("newBranch")}
                disabled={!canEdit}
                onClick={onNewBranch}
              >
                <Plus size={13} />
              </button>
            </div>
            <GitSyncButton
              worktree={worktree}
              commit={snapshot.commit}
              version={gitVersion}
              onClick={onGit}
            />
            <span className="header-divider" />
            <label className="environment-picker">
              <span className={`env-dot ${environment}`} />
              <Select
                aria-label={t("environment")}
                value={environment}
                onChange={(e) => onEnvironment(e.target.value)}
              >
                {workspace?.catalog.environments.map((env: string) => (
                  <option key={env}>{env}</option>
                ))}
              </Select>
            </label>
          </>
        )}
        {instanceAdmin && <ResourceMonitor />}
        <AccountMenu
          username={workspace?.user.username || ""}
          preferences={preferences}
          onSettings={() => onArea("userSettings")}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  );
}
