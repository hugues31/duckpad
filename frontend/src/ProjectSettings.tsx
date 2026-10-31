import { useCallback, useEffect, useState } from "react";
import { Plus, Shield, Trash2 } from "lucide-react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { Modal } from "./modals";
import RoleSelect, { PROJECT_ROLES } from "./RoleSelect";
import Select from "./Select";
import type { ProjectRole, Workspace } from "./types";
import { useAsyncAction } from "./useAsyncAction";
import { useRevisionDraft } from "./useRevisionDraft";

interface Member {
  id: string;
  username: string;
  active: boolean;
  role: ProjectRole;
  auth_method?: "oidc" | "service";
}

interface Settings {
  project: { name: string };
  /** The role of the signed-in user. */
  role: ProjectRole;
  members: Member[];
  /** Active accounts that can join the project; listed for its admins only. */
  users: { id: string; username: string; auth_method?: "oidc" | "service" }[];
  /** The granted connections. */
  connections: string[];
}

type Confirmation = { kind: "delete" } | { kind: "remove"; member: Member };

const NO_CONNECTIONS: string[] = [];
/** Connection grants form a set: their order does not matter. */
const sameConnections = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id) => b.includes(id));

/** A project's participants, authorized connections and deletion. */
export default function ProjectSettings({
  project,
  workspace,
  refresh,
  onDeleted,
}: {
  project: string;
  workspace: Workspace;
  refresh: () => Promise<unknown>;
  onDeleted: () => void;
}) {
  const t = useT();
  const [selectedUser, setSelectedUser] = useState("");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const { pending, error, setError, run } = useAsyncAction();
  const read = useCallback(
    () => api<Settings>(`/projects/${project}/settings`),
    [project],
  );
  useEffect(() => {
    read().then(setSettings, (e) => setError(e.message));
  }, [read, setError]);
  // Reloads after other changes keep unsaved grants, which guard navigation.
  const grants = useRevisionDraft<string[], Settings | null>(
    settings?.connections ?? NO_CONNECTIONS,
    settings,
    async (connections, revision) => {
      await api(
        `/projects/${project}/connections`,
        send({ connections }, "PUT"),
      );
      return revision;
    },
    { equal: sameConnections },
  );
  const act = (action: () => Promise<unknown>) =>
    run(async () => {
      await action();
      setConfirmation(null);
      setSettings(await read());
      await refresh();
    });
  const deleteProject = () =>
    run(async () => {
      await api(`/projects/${project}`, { method: "DELETE" });
      // Unsaved grants of a deleted project must not hold back leaving its page.
      grants.discard();
      await refresh();
      onDeleted();
    });
  const admin = settings?.role === "admin";
  const available =
    settings?.users.filter(
      (u) => !settings.members.some((m) => m.id === u.id),
    ) || [];
  return (
    <section className="full-panel administration-page project-settings">
      <div className="settings-container">
        <div className="administration-heading">
          <div>
            <span className="eyebrow">
              {settings?.project.name || t("project")}
            </span>
            <h1>
              <Shield size={28} />
              {t("projectSettings")}
            </h1>
            <p className="muted">{t("projectAccessHint")}</p>
          </div>
          {settings && (
            <span className="access-badge active">
              {t(`role_${settings.role}`)}
            </span>
          )}
        </div>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <div className="role-guide">
          {PROJECT_ROLES.map((role) => (
            <div key={role}>
              <strong>{t(`role_${role}`)}</strong>
              <p>{t(`project_${role}_hint`)}</p>
            </div>
          ))}
        </div>
        <div className="project-settings-grid">
          <div className="settings-card">
            <h2>{t("participants")}</h2>
            {admin && (
              <form
                className="member-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  void act(() =>
                    api(
                      `/projects/${project}/members/${data.get("user")}`,
                      send({ role: data.get("role") }, "PUT"),
                    ),
                  );
                }}
              >
                <label className="field">
                  <span>{t("user")}</span>
                  <Select
                    aria-label={t("user")}
                    name="user"
                    value={selectedUser}
                    onChange={(e) => setSelectedUser(e.target.value)}
                    required
                    disabled={!available.length}
                  >
                    <option value="">
                      {t(available.length ? "chooseUser" : "noAvailableUsers")}
                    </option>
                    {available.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.username}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="field">
                  <span>{t("projectRole")}</span>
                  <Select
                    aria-label={t("projectRole")}
                    name="role"
                    key={selectedUser}
                    defaultValue="reader"
                  >
                    {(available.find((u) => u.id === selectedUser)
                      ?.auth_method === "service"
                      ? (["reader"] as const)
                      : PROJECT_ROLES
                    ).map((role) => (
                      <option key={role} value={role}>
                        {t(`role_${role}`)}
                      </option>
                    ))}
                  </Select>
                </label>
                <button
                  className="button primary"
                  disabled={pending || !available.length}
                >
                  <Plus size={16} />
                  {t("addParticipant")}
                </button>
              </form>
            )}
            <div className="administration-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("username")}</th>
                    <th>{t("projectRole")}</th>
                    <th>{t("actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {settings?.members.map((member) => (
                    <tr key={member.id}>
                      <td>
                        <strong>{member.username}</strong>
                        {!member.active && (
                          <small className="muted">
                            {" "}
                            · {t("accountInactive")}
                          </small>
                        )}
                      </td>
                      <td>
                        <RoleSelect
                          label={`${t("projectRole")} · ${member.username}`}
                          value={member.role}
                          disabled={
                            !admin ||
                            pending ||
                            !member.active ||
                            member.auth_method === "service"
                          }
                          onChange={(role) =>
                            act(() =>
                              api(
                                `/projects/${project}/members/${member.id}`,
                                send({ role }, "PUT"),
                              ),
                            )
                          }
                        />
                      </td>
                      <td>
                        {admin && (
                          <button
                            className="text-button danger"
                            disabled={pending}
                            onClick={() =>
                              setConfirmation({ kind: "remove", member })
                            }
                          >
                            <Trash2 size={14} />
                            {t("removeAccess")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">{t("lastAdminHint")}</p>
          </div>
          <div className="project-settings-secondary">
            {workspace.user.role === "admin" && (
              <div className="settings-card">
                <h2>{t("authorizedConnections")}</h2>
                <p className="muted">{t("authorizedConnectionsHint")}</p>
                <div className="connection-grants">
                  {workspace.catalog.connections.map((c) => (
                    <label key={c.id}>
                      <input
                        type="checkbox"
                        checked={grants.draft.includes(c.id)}
                        onChange={(e) => {
                          const granted = e.target.checked;
                          grants.update((ids) =>
                            granted
                              ? [...ids, c.id]
                              : ids.filter((id) => id !== c.id),
                          );
                        }}
                      />
                      {c.name}
                    </label>
                  ))}
                </div>
                <div className="row gap">
                  <button
                    className="button secondary"
                    disabled={pending || !grants.dirty}
                    onClick={() => act(grants.persist)}
                  >
                    {t("saveConnections")}
                  </button>
                  {grants.dirty && (
                    <span className="muted small">{t("unsavedChanges")}</span>
                  )}
                </div>
              </div>
            )}
            {admin && (
              <div className="settings-card danger-zone">
                <h2>{t("deleteProject")}</h2>
                <p className="muted">{t("deleteProjectHint")}</p>
                <button
                  className="button secondary danger"
                  onClick={() => setConfirmation({ kind: "delete" })}
                >
                  {t("deleteProject")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {confirmation && (
        <Modal
          title={t(
            confirmation.kind === "delete" ? "deleteProject" : "removeAccess",
          )}
          onClose={() => setConfirmation(null)}
        >
          <div className="modal-content">
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
            {error && (
              <p className="notice error" role="alert">
                {error}
              </p>
            )}
          </div>
          <footer>
            <button
              className="button secondary"
              onClick={() => setConfirmation(null)}
            >
              {t("cancel")}
            </button>
            <button
              className="button primary"
              disabled={pending}
              onClick={() =>
                confirmation.kind === "delete"
                  ? deleteProject()
                  : act(() =>
                      api(
                        `/projects/${project}/members/${confirmation.member.id}`,
                        { method: "DELETE" },
                      ),
                    )
              }
            >
              {t("confirm")}
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );
}
