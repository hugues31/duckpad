import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import type { Confirmation, Settings } from "./projectSettingsTypes";
import RoleSelect, { PROJECT_ROLES } from "./RoleSelect";
import Select from "./Select";

export default function ProjectParticipants({
  admin,
  act,
  project,
  available,
  pending,
  settings,
  setConfirmation,
}: {
  admin: boolean;
  act: (action: () => Promise<unknown>) => Promise<boolean>;
  project: string;
  available: Settings["users"];
  pending: boolean;
  settings: Settings | null;
  setConfirmation: (confirmation: Confirmation) => void;
}) {
  const t = useT();
  const [selectedUser, setSelectedUser] = useState("");
  return (
    <>
      <div className="role-guide">
        {PROJECT_ROLES.map((role) => (
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
                {(available.find((u) => u.id === selectedUser)?.auth_method ===
                "service"
                  ? (["reader", "operator"] as const)
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
                      <small className="muted"> · {t("accountInactive")}</small>
                    )}
                  </td>
                  <td>
                    <RoleSelect
                      label={`${t("projectRole")} · ${member.username}`}
                      value={member.role}
                      service={member.auth_method === "service"}
                      disabled={!admin || pending || !member.active}
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
    </>
  );
}
