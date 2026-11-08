import { useT } from "./i18n";
import type { Workspace } from "./types";
import { useSettingsForm } from "./useSettingsForm";

export default function ProjectConnections({
  instanceAdmin,
  workspace,
  grants,
  pending,
  act,
}: {
  instanceAdmin: boolean;
  workspace: Workspace;
  grants: ReturnType<typeof useSettingsForm<string[]>>;
  pending: boolean;
  act: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const t = useT();
  return (
    <div className="settings-card">
      <h2>{t("authorizedConnections")}</h2>
      <p className="muted">{t("authorizedConnectionsHint")}</p>
      {!instanceAdmin && (
        <p className="notice">{t("projectInstanceAdminHint")}</p>
      )}
      <div className="connection-grants">
        {workspace.catalog.connections.map((c) => (
          <label key={c.id}>
            <input
              type="checkbox"
              checked={grants.config!.includes(c.id)}
              disabled={!instanceAdmin || pending}
              onChange={(e) => {
                const granted = e.target.checked;
                grants.update((ids) =>
                  granted ? [...ids, c.id] : ids.filter((id) => id !== c.id),
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
          disabled={!instanceAdmin || pending || !grants.dirty}
          onClick={() => act(grants.persist)}
        >
          {t("saveConnections")}
        </button>
        {grants.dirty && (
          <span className="muted small">{t("unsavedChanges")}</span>
        )}
      </div>
    </div>
  );
}
