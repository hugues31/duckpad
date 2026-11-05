import { Link, useNavigate } from "react-router";
import { usePageRoute, worktreeUrl } from "./navigation";
import Select from "./Select";
import {
  GitBranch,
  HelpCircle,
  Layers,
  Plus,
  Workflow,
  Settings2,
  Search,
} from "lucide-react";
import AccountMenu from "./AccountMenu";
import DuckMark from "./DuckMark";
import GitSyncButton from "./GitSyncButton";
import { useT } from "./i18n";
import ResourceMonitor from "./ResourceMonitor";
import { searchShortcutLabel } from "./searchShortcuts";
import { useShell } from "./shell";
import { useWorktree } from "./worktree";

const RAIL = [
  ["pipelines", Workflow],
  ["instanceSettings", Settings2],
] as const;

export default function TopBar({
  pipelineUrl,
  onSearch,
  onSignOut,
}: {
  /** Where the Pipelines link leads. */
  pipelineUrl: string;
  onSearch: () => void;
  onSignOut: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { area, tab, projectId } = usePageRoute();
  const { workspace, environment, preferences, openModal, openWorktree } =
    useShell();
  const { id: worktree, snapshot, canEdit, gitVersion } = useWorktree();
  const instanceAdmin = workspace?.user.role === "admin";
  const projectArea =
    area === "pipelines" || area === "projectSettings" || area === "jobs";
  const project =
    projectId ||
    workspace?.worktrees.find((w) => w.id === worktree)?.project ||
    "";
  return (
    <header className="topbar">
      <nav className="rail" aria-label={t("workspace")}>
        <Link
          to="/projects"
          className="brand-button"
          title="Duckpad"
          aria-label={t("backToProjects")}
          aria-current={area === "projects" ? "page" : undefined}
        >
          <DuckMark size={30} />
        </Link>
        <div className="rail-main">
          {RAIL.filter(([key]) => key === "pipelines" || instanceAdmin).map(
            ([key, Icon]) => (
              <Link
                to={key === "pipelines" ? pipelineUrl : "/instance-settings"}
                key={key}
                className={`rail-button ${area === key ? "active" : ""}`}
                title={t(key)}
                aria-label={t(key)}
                aria-current={area === key ? "page" : undefined}
              >
                <Icon size={21} />
              </Link>
            ),
          )}
        </div>
        <button
          className="rail-button"
          title={`${t("instanceSearch")} (${searchShortcutLabel("k")})`}
          aria-label={t("instanceSearch")}
          aria-keyshortcuts="Control+K Meta+K"
          onClick={onSearch}
          disabled={!workspace}
        >
          <Search size={21} />
        </button>
        <button
          className="rail-button"
          title={t("help")}
          onClick={() => openModal({ kind: "about" })}
        >
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
              value={project}
              onChange={(e) => {
                const selected = workspace?.projects.find(
                  (p) => p.id === e.target.value,
                );
                if (selected) openWorktree(selected.main);
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
            onClick={() => openModal({ kind: "newProject" })}
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
                onChange={(e) => openWorktree(e.target.value, tab)}
              >
                {snapshot.worktree.read_only && (
                  <option value={worktree}>{t("jobResults")}</option>
                )}
                {workspace?.worktrees
                  .filter(
                    (w) =>
                      w.project === snapshot.worktree.project && !w.read_only,
                  )
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
                onClick={() => openModal({ kind: "newBranch", worktree })}
              >
                <Plus size={13} />
              </button>
            </div>
            {!snapshot.worktree.read_only && (
              <GitSyncButton
                worktree={worktree}
                commit={snapshot.commit}
                version={gitVersion}
                onClick={() =>
                  openModal({ kind: "git", worktree, mode: "sync" })
                }
              />
            )}
            <span className="header-divider" />
            <label className="environment-picker">
              <span
                className="env-dot"
                style={{
                  background: workspace?.catalog.environment_details.find(
                    (item) => item.id === environment,
                  )?.color,
                }}
              />
              <Select
                aria-label={t("environment")}
                value={environment}
                onChange={(e) =>
                  void navigate(worktreeUrl(worktree, tab, e.target.value))
                }
              >
                {workspace?.catalog.environment_details.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.label}
                  </option>
                ))}
              </Select>
            </label>
          </>
        )}
        {instanceAdmin && <ResourceMonitor />}
        <AccountMenu
          username={workspace?.user.username || ""}
          preferences={preferences}
          onSignOut={onSignOut}
        />
      </div>
    </header>
  );
}
