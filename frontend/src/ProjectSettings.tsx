import {
  Code2,
  Database,
  Layers,
  Puzzle,
  Settings as SettingsIcon,
  Users,
} from "lucide-react";
import { useCallback, useState } from "react";
import { NavLink, useLocation } from "react-router";
import { api, send } from "./api";
import { useT } from "./i18n";
import { ConfirmModal } from "./modals";
import { projectSettingsSections, projectSettingsUrl } from "./navigation";
import { PartitionSettings } from "./PartitionControls";
import ProjectConnections from "./ProjectConnections";
import ProjectExtensions from "./ProjectExtensions";
import ProjectGeneralSettings from "./ProjectGeneralSettings";
import ProjectParticipants from "./ProjectParticipants";
import ProjectPythonSettings from "./ProjectPythonSettings";
import { Confirmation, Settings } from "./projectSettingsTypes";
import SettingsLayout from "./SettingsLayout";
import type { Workspace } from "./types";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { useSettingsForm } from "./useSettingsForm";

const sectionIcons = {
  participants: Users,
  connections: Database,
  python: Code2,
  partitions: Layers,
  extensions: Puzzle,
  general: SettingsIcon,
};

const NO_PYTHON = { enabled: false, allow_builds: false };
const NO_CONNECTIONS: string[] = [];
/** Connection grants form a set: their order does not matter. */
const sameConnections = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** Project access, runtime policies, branch partitions and general settings. */
export default function ProjectSettings({
  project,
  section = "participants",
  workspace,
  refresh,
  onDeleted,
  onGit,
}: {
  project: string;
  section?: string;
  workspace: Workspace;
  refresh: () => Promise<unknown>;
  onDeleted: () => void;
  onGit?: () => void;
}) {
  const t = useT();
  const { search } = useLocation();
  const [selectedUser, setSelectedUser] = useState("");
  const {
    data: settings,
    setData: setSettings,
    error: loadError,
  } = useApiResource<Settings>(`/projects/${project}/settings`);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const { pending, error: actionError, run } = useAsyncAction();
  const error = actionError || loadError;
  const read = useCallback(
    () => api<Settings>(`/projects/${project}/settings`),
    [project],
  );
  // Reloads after other changes keep unsaved grants, which guard navigation.
  const grants = useSettingsForm<string[]>(
    settings?.connections ?? NO_CONNECTIONS,
    async (connections) => {
      await api(
        `/projects/${project}/connections`,
        send({ connections }, "PUT"),
      );
      setSettings(await read());
    },
    { equal: sameConnections },
  );
  const python = useSettingsForm(
    settings?.python ?? NO_PYTHON,
    async (policy) => {
      await api(`/projects/${project}/python`, send(policy, "PUT"));
      setSettings(await read());
    },
    {
      equal: (a, b) =>
        a.enabled === b.enabled && a.allow_builds === b.allow_builds,
    },
  );
  const apply = async (action: () => Promise<unknown>) => {
    await action();
    setConfirmation(null);
    setSettings(await read());
    await refresh();
  };
  const act = (action: () => Promise<unknown>) => run(() => apply(action));
  const deleteProject = async () => {
    await api(`/projects/${project}`, { method: "DELETE" });
    // Unsaved grants of a deleted project must not hold back leaving its page.
    grants.discard();
    python.discard();
    await refresh();
    onDeleted();
  };
  const admin = settings?.role === "admin";
  const instanceAdmin = workspace.user.role === "admin";
  const available =
    settings?.users.filter(
      (u) => !settings.members.some((m) => m.id === u.id),
    ) || [];
  return (
    <>
      <SettingsLayout
        className="project-settings"
        title={t("projectSettings")}
        eyebrow={settings?.project.name || t("project")}
        description={t("projectAccessHint")}
        badge={
          settings && (
            <span className="access-badge active">
              {t(`role_${settings.role}`)}
            </span>
          )
        }
        navigation={projectSettingsSections.map(([slug, label]) => {
          const Icon = sectionIcons[slug];
          return (
            <NavLink
              key={slug}
              to={`${projectSettingsUrl(project, slug)}${search}`}
              end
            >
              <Icon size={18} aria-hidden="true" />
              <span>{t(label)}</span>
            </NavLink>
          );
        })}
      >
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {section === "partitions" && <PartitionSettings />}
        {section === "extensions" && <ProjectExtensions />}
        {section === "participants" && (
          <ProjectParticipants
            admin={admin}
            act={act}
            project={project}
            selectedUser={selectedUser}
            setSelectedUser={setSelectedUser}
            available={available}
            pending={pending}
            settings={settings}
            setConfirmation={setConfirmation}
          />
        )}
        {/* Drafts start from the loaded settings, so an early edit cannot drop saved values. */}
        {section === "connections" && settings && (
          <ProjectConnections
            instanceAdmin={instanceAdmin}
            workspace={workspace}
            grants={grants}
            pending={pending}
            act={act}
          />
        )}
        {section === "python" && settings && (
          <ProjectPythonSettings
            instanceAdmin={instanceAdmin}
            python={python}
            pending={pending}
            act={act}
            project={project}
          />
        )}
        {section === "general" && (
          <ProjectGeneralSettings
            onGit={onGit}
            settings={settings}
            admin={admin}
            setConfirmation={setConfirmation}
          />
        )}
      </SettingsLayout>
      {confirmation && (
        <ConfirmModal
          title={t(
            confirmation.kind === "delete" ? "deleteProject" : "removeAccess",
          )}
          confirmLabel={t("confirm")}
          onClose={() => setConfirmation(null)}
          onConfirm={() =>
            confirmation.kind === "delete"
              ? deleteProject()
              : apply(() =>
                  api(
                    `/projects/${project}/members/${confirmation.member.id}`,
                    { method: "DELETE" },
                  ),
                )
          }
        >
          <p>
            {t(
              confirmation.kind === "delete"
                ? "confirmDeleteProject"
                : "confirmRemoveAccess",
            )}{" "}
            <strong>
              {confirmation.kind === "remove"
                ? confirmation.member.username
                : settings?.project.name}
            </strong>
          </p>
        </ConfirmModal>
      )}
    </>
  );
}
