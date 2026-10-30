import { useEffect, useState } from "react";
import { Plus, Users } from "lucide-react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { Modal } from "./modals";
import RoleSelect from "./RoleSelect";
import Select from "./Select";
import type { Json } from "./types";
import { useAsyncAction } from "./useAsyncAction";

const readUsers = () => api<Json[]>("/users");

/** Instance accounts: creation, instance roles, passwords and deactivation. */
export default function UsersPage({
  refresh,
}: {
  refresh: () => Promise<unknown>;
}) {
  const t = useT();
  const [users, setUsers] = useState<Json[]>([]);
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState<Json | null>(null);
  const { pending, error, setError, run } = useAsyncAction();
  // The dialog reports its own errors, next to the form that caused them.
  const dialog = useAsyncAction();
  const busy = pending || dialog.pending;
  useEffect(() => {
    readUsers().then(setUsers, (e) => setError(e.message));
  }, [setError]);
  async function reload() {
    setUsers(await readUsers());
    await refresh();
  }
  const update = (id: string, data: Json) =>
    run(async () => {
      await api(`/users/${id}`, send(data, "PATCH"));
      await reload();
    });
  function open(value: Json) {
    dialog.setError("");
    setModal(value);
  }
  async function submit({ kind, user }: Json, data: FormData) {
    const saved = await dialog.run(() =>
      kind === "create"
        ? api(
            "/users",
            send({
              username: data.get("username"),
              password: data.get("password"),
              role: data.get("role"),
            }),
          )
        : api(
            `/users/${user.id}`,
            send(
              kind === "deactivate"
                ? { active: false }
                : { password: data.get("password") },
              "PATCH",
            ),
          ),
    );
    if (!saved) return;
    setModal(null);
    await run(reload);
  }
  const visible = users.filter((u) =>
    u.username.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <section className="administration-page">
      <div className="administration-heading">
        <div>
          <h2>
            <Users size={28} />
            {t("users")}
          </h2>
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
              <th>{t("accountStatus")}</th>
              <th>{t("actions")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((user) => (
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
        {!visible.length && <p className="muted">{t("noUsers")}</p>}
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
            onSubmit={(e) => {
              e.preventDefault();
              void submit(modal, new FormData(e.currentTarget));
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
              {dialog.error && (
                <p className="notice error" role="alert">
                  {dialog.error}
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
