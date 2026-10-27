import Select from "./Select";
import { useCallback, useEffect, useState } from "react";
import { Plus, Shield, Trash2, Users } from "lucide-react";
import { api, send } from "./api";
import type { Json, Workspace } from "./types";
import { useT } from "./i18n";
import { Modal } from "./modals";

function RoleSelect({
  value,
  onChange,
  instance = false,
  disabled = false,
  label,
}: {
  value: string;
  onChange: (role: string) => void;
  instance?: boolean;
  disabled?: boolean;
  label: string;
}) {
  const t = useT();
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {(instance ? ["member", "admin"] : ["reader", "editor", "admin"]).map(
        (role) => (
          <option key={role} value={role}>
            {t(`role_${role}`)}
          </option>
        ),
      )}
    </Select>
  );
}

export function UsersPage({ refresh }: { refresh: () => Promise<unknown> }) {
  const t = useT();
  const [users, setUsers] = useState<Json[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<Json | null>(null);
  const [modalError, setModalError] = useState("");
  const load = useCallback(async () => setUsers(await api("/users")), []);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  async function update(id: string, data: Json) {
    setBusy(true);
    setError("");
    try {
      await api(`/users/${id}`, send(data, "PATCH"));
      await load();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function open(value: Json) {
    setModalError("");
    setModal(value);
  }
  return (
    <section className="full-panel administration-page">
      <div className="administration-heading">
        <div>
          <span className="eyebrow">{t("instance")}</span>
          <h1>
            <Users size={28} />
            {t("users")}
          </h1>
          <p className="muted">{t("usersDescription")}</p>
        </div>
        <button
          className="button primary"
          onClick={() => open({ kind: "create" })}
        >
          <Plus size={16} />
          {t("addUser")}
        </button>
      </div>
      <div className="notice">{t("instanceRolesHint")}</div>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <input
        className="administration-search"
        aria-label={t("searchUsers")}
        placeholder={t("searchUsers")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="settings-card administration-table">
        <table>
          <thead>
            <tr>
              <th>{t("username")}</th>
              <th>{t("instanceRole")}</th>
              <th>{t("status")}</th>
              <th>{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {users
              .filter((u) =>
                u.username.toLowerCase().includes(query.toLowerCase()),
              )
              .map((user) => (
                <tr key={user.id}>
                  <td>
                    <strong>{user.username}</strong>
                    {user.auth_method === "oidc" && (
                      <small className="muted"> · SSO</small>
                    )}
                  </td>
                  <td>
                    <RoleSelect
                      instance
                      label={`${t("instanceRole")} · ${user.username}`}
                      value={user.role}
                      disabled={busy}
                      onChange={(role) => update(user.id, { role })}
                    />
                  </td>
                  <td>
                    <span
                      className={`access-badge ${user.active ? "active" : ""}`}
                    >
                      {t(user.active ? "accountActive" : "accountInactive")}
                    </span>
                  </td>
                  <td>
                    <div className="row gap">
                      <button
                        className="button secondary small"
                        disabled={busy || user.auth_method === "oidc"}
                        title={
                          user.auth_method === "oidc"
                            ? t("ssoPasswordManaged")
                            : undefined
                        }
                        onClick={() => open({ kind: "password", user })}
                      >
                        {t("resetPassword")}
                      </button>
                      <button
                        className="text-button"
                        disabled={busy}
                        onClick={() =>
                          user.active
                            ? open({ kind: "deactivate", user })
                            : update(user.id, { active: true })
                        }
                      >
                        {t(user.active ? "deactivate" : "reactivate")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
        {!users.filter((u) =>
          u.username.toLowerCase().includes(query.toLowerCase()),
        ).length && <p className="muted">{t("noUsers")}</p>}
      </div>
      {modal && (
        <Modal
          title={t(
            modal.kind === "create"
              ? "addUser"
              : modal.kind === "password"
                ? "resetPassword"
                : "deactivate",
          )}
          onClose={() => setModal(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              setBusy(true);
              setModalError("");
              try {
                if (modal.kind === "create")
                  await api(
                    "/users",
                    send({
                      username: data.get("username"),
                      password: data.get("password"),
                      role: data.get("role"),
                    }),
                  );
                else
                  await api(
                    `/users/${modal.user.id}`,
                    send(
                      modal.kind === "deactivate"
                        ? { active: false }
                        : { password: data.get("password") },
                      "PATCH",
                    ),
                  );
                setModal(null);
                await load();
                await refresh();
              } catch (e) {
                setModalError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="modal-content">
              {modal.kind === "create" && (
                <>
                  <label className="field">
                    <span>{t("username")}</span>
                    <input
                      name="username"
                      required
                      maxLength={64}
                      pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*"
                      autoComplete="off"
                    />
                  </label>
                  <label className="field">
                    <span>{t("instanceRole")}</span>
                    <Select
                      aria-label={t("instanceRole")}
                      name="role"
                      defaultValue="member"
                    >
                      <option value="member">{t("role_member")}</option>
                      <option value="admin">{t("role_admin")}</option>
                    </Select>
                  </label>
                </>
              )}
              {modal.kind === "deactivate" ? (
                <p>
                  {t("deactivateHint")} <strong>{modal.user.username}</strong>
                </p>
              ) : (
                <label className="field">
                  <span>{t("newPassword")}</span>
                  <input
                    aria-label={t("newPassword")}
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    maxLength={1024}
                    autoComplete="new-password"
                  />
                  <small>{t("passwordHint")}</small>
                </label>
              )}
              {modalError && (
                <p className="notice error" role="alert">
                  {modalError}
                </p>
              )}
            </div>
            <footer>
              <button
                type="button"
                className="button secondary"
                onClick={() => setModal(null)}
              >
                {t("cancel")}
              </button>
              <button className="button primary" disabled={busy}>
                {t(
                  modal.kind === "create"
                    ? "create"
                    : modal.kind === "deactivate"
                      ? "deactivate"
                      : "save",
                )}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function ProjectSettings({
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
  const [settings, setSettings] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [connections, setConnections] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<Json | null>(null);
  const load = useCallback(async () => {
    const result = await api(`/projects/${project}/settings`);
    setSettings(result);
    setConnections(result.connections);
  }, [project]);
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);
  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setConfirmation(null);
      await load();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const admin = settings?.role === "admin";
  const available =
    settings?.users.filter(
      (u: Json) => !settings.members.some((m: Json) => m.id === u.id),
    ) || [];
  return (
    <section className="full-panel administration-page">
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
        {["reader", "editor", "admin"].map((role) => (
          <div key={role}>
            <strong>{t(`role_${role}`)}</strong>
            <p>{t(`project_${role}_hint`)}</p>
          </div>
        ))}
      </div>
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
                required
                disabled={!available.length}
              >
                <option value="">
                  {t(available.length ? "chooseUser" : "noAvailableUsers")}
                </option>
                {available.map((u: Json) => (
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
                defaultValue="reader"
              >
                {["reader", "editor", "admin"].map((role) => (
                  <option key={role} value={role}>
                    {t(`role_${role}`)}
                  </option>
                ))}
              </Select>
            </label>
            <button
              className="button primary"
              disabled={busy || !available.length}
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
              {settings?.members.map((member: Json) => (
                <tr key={member.id}>
                  <td>
                    <strong>{member.username}</strong>
                    {!member.active && (
                      <small className="muted"> · {t("accountInactive")}</small>
                    )}
                  </td>
                  <td>
                    <RoleSelect
                      label={`${t("projectRole")} · ${member.username}`}
                      value={member.role}
                      disabled={!admin || busy || !member.active}
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
                        disabled={busy}
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
      {workspace.user.role === "admin" && (
        <div className="settings-card">
          <h2>{t("authorizedConnections")}</h2>
          <p className="muted">{t("authorizedConnectionsHint")}</p>
          <div className="connection-grants">
            {workspace.catalog.connections.map((c: Json) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={connections.includes(c.id)}
                  onChange={(e) =>
                    setConnections(
                      e.target.checked
                        ? [...connections, c.id]
                        : connections.filter((id) => id !== c.id),
                    )
                  }
                />
                {c.name}
              </label>
            ))}
          </div>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() =>
              act(() =>
                api(
                  `/projects/${project}/connections`,
                  send({ connections }, "PUT"),
                ),
              )
            }
          >
            {t("saveConnections")}
          </button>
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
                {confirmation.member?.username || settings?.project.name}
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
              disabled={busy}
              onClick={() => {
                if (confirmation.kind === "delete") {
                  setBusy(true);
                  api(`/projects/${project}`, { method: "DELETE" })
                    .then(async () => {
                      await refresh();
                      onDeleted();
                    })
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                } else
                  void act(() =>
                    api(
                      `/projects/${project}/members/${confirmation.member.id}`,
                      { method: "DELETE" },
                    ),
                  );
              }}
            >
              {t("confirm")}
            </button>
          </footer>
        </Modal>
      )}
    </section>
  );
}

export function PasswordForm({ onChanged }: { onChanged: () => void }) {
  const t = useT();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="settings-card">
      <h2>{t("changePassword")}</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          setBusy(true);
          setError("");
          try {
            await api(
              "/password",
              send({
                current: data.get("current"),
                password: data.get("password"),
              }),
            );
            onChanged();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span>{t("currentPassword")}</span>
          <input
            name="current"
            type="password"
            required
            autoComplete="current-password"
          />
        </label>
        <label className="field">
          <span>{t("newPassword")}</span>
          <input
            aria-label={t("newPassword")}
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={1024}
            autoComplete="new-password"
          />
          <small>{t("passwordChangeHint")}</small>
        </label>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" disabled={busy}>
          {t("changePassword")}
        </button>
      </form>
    </div>
  );
}
