import { Copy, Plus, RotateCcw, Settings2 } from "lucide-react";
import { useState } from "react";
import { api } from "./api";
import ConnectionEditorModal from "./ConnectionEditorModal";
import { FAMILIES, familyOf } from "./connectionFamilies";
import { useT } from "./i18n";
import { ConfirmModal } from "./modals";
import type {
  Connection,
  Connector,
  ConnectorEditor,
  Workspace,
} from "./types";

/** The definition as the administrator edits it, without the listing's origin. */
function definitionText(connector: Connector) {
  const { origin: _, ...definition } = connector;
  return JSON.stringify(definition, null, 2);
}

export default function ConnectionsPanel({
  workspace,
  refresh,
  onEditor,
  onCreated,
}: {
  workspace: Workspace;
  refresh: () => Promise<void>;
  onEditor: (editor: ConnectorEditor) => void;
  onCreated?: (connection: Connection) => Promise<void>;
}) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [environment, setEnvironment] = useState("");
  const [resetting, setResetting] = useState<Connector | null>(null);
  const [selected, setSelected] = useState<Connection | null>(null);
  const { catalog } = workspace;
  const connectorOf = (id?: string) =>
    catalog.connectors.find((c) => c.id === id);
  return (
    <section>
      <div className="page-heading">
        <div>
          <h2>{t("connections")}</h2>
          <p>{t("catalogHint")}</p>
        </div>
        <button
          className="button primary"
          onClick={() => {
            setCreating(true);
            setSelected({
              id: "",
              name: "",
              connector: "folder",
              environments: Object.fromEntries(
                catalog.environments.map((e) => [e, {}]),
              ),
            });
          }}
        >
          <Plus size={16} />
          {t("newConnection")}
        </button>
      </div>
      {onCreated && <p className="notice">{t("sourceConnectionReturnHint")}</p>}
      {FAMILIES.map(({ family, label, icon: Icon }) => {
        const connections = catalog.connections.filter(
          (c) => familyOf(connectorOf(c.connector)) === family,
        );
        return (
          <section
            key={family}
            className="connection-family"
            aria-labelledby={`connections-${family}`}
          >
            <h3 id={`connections-${family}`}>{t(label)}</h3>
            {connections.length ? (
              <div className="connection-grid">
                {connections.map((connection) => (
                  <button
                    key={connection.id}
                    className="connection-card"
                    onClick={() => {
                      setCreating(false);
                      setSelected(structuredClone(connection));
                    }}
                  >
                    <span className="connection-logo">
                      <Icon size={24} />
                    </span>
                    <strong>{connection.name}</strong>
                    <span>
                      {connectorOf(connection.connector)?.name ||
                        connection.connector}
                    </span>
                    <div className="row gap">
                      {catalog.environment_details
                        .filter((e) =>
                          Object.values(
                            connection.environments[e.id] ?? {},
                          ).some(
                            (value) =>
                              value != null &&
                              (typeof value !== "string" ||
                                value.trim() !== ""),
                          ),
                        )
                        .map((e) => (
                          <span key={e.id} className="env-badge">
                            <span
                              className="env-dot"
                              style={{ background: e.color }}
                            />
                            {e.label}
                          </span>
                        ))}
                    </div>
                    <Settings2 size={16} className="card-corner" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted small">{t("noConnectionInFamily")}</p>
            )}
          </section>
        );
      })}
      <div className="row spread section-heading">
        <h2>{t("connectorDefinitions")}</h2>
        <button
          className="button secondary small"
          onClick={() =>
            onEditor({
              title: t("newConnector"),
              value: JSON.stringify(
                {
                  id: "custom",
                  name: "Custom connector",
                  family: "database",
                  description: "",
                  parameters: [{ name: "path", type: "text" }],
                  extensions: [],
                  capabilities: ["read", "write"],
                  init_sql: "",
                  compatibility: "DuckDB >=2.0",
                },
                null,
                2,
              ),
            })
          }
        >
          <Plus size={15} />
          {t("newConnector")}
        </button>
      </div>
      {FAMILIES.map(({ family, label }) => (
        <section
          key={family}
          className="connector-family"
          aria-labelledby={`connectors-${family}`}
        >
          <h3 id={`connectors-${family}`}>{t(label)}</h3>
          {catalog.connectors
            .filter((connector) => familyOf(connector) === family)
            .map((connector) => {
              const name = connector.name ?? connector.id;
              return (
                <div className="connector-row" key={connector.id}>
                  <div>
                    <div className="row gap">
                      <strong>{connector.name}</strong>
                      {connector.origin === "built-in" && (
                        <span className="badge neutral">{t("builtIn")}</span>
                      )}
                      {connector.origin === "customized" && (
                        <span className="badge stale">{t("customized")}</span>
                      )}
                    </div>
                    <p>{connector.description}</p>
                    <small>{connector.compatibility}</small>
                  </div>
                  <div className="row gap connector-actions">
                    {(connector.capabilities ?? []).map((c) => (
                      <span key={c} className="badge neutral">
                        {t(c)}
                      </span>
                    ))}
                    <button
                      className="button secondary small"
                      aria-label={`${t("edit")} ${name}`}
                      onClick={() =>
                        onEditor({
                          title: name,
                          value: definitionText(connector),
                          identity: connector.id,
                        })
                      }
                    >
                      {t("edit")}
                    </button>
                    <button
                      className="button secondary small"
                      aria-label={`${t("duplicate")} ${name}`}
                      onClick={() =>
                        onEditor({
                          title: t("duplicateConnector"),
                          value: definitionText({
                            ...connector,
                            id: `${connector.id}_copy`,
                            name: t("copyName").replace("{name}", name),
                          }),
                        })
                      }
                    >
                      <Copy size={14} />
                      {t("duplicate")}
                    </button>
                    {connector.origin === "customized" && (
                      <button
                        className="button secondary small"
                        aria-label={`${t("resetToBuiltIn")} ${name}`}
                        onClick={() => setResetting(connector)}
                      >
                        <RotateCcw size={14} />
                        {t("resetToBuiltIn")}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
        </section>
      ))}
      {resetting && (
        <ConfirmModal
          title={t("resetToBuiltIn")}
          confirmLabel={t("resetToBuiltIn")}
          onClose={() => setResetting(null)}
          onConfirm={async () => {
            await api(
              `/catalog/connector/${encodeURIComponent(resetting.id)}/reset`,
              { method: "POST" },
            );
            await refresh();
          }}
        >
          <p>
            <strong>{resetting.name}</strong> ({resetting.id})
          </p>
          <p>{t("resetToBuiltInHint")}</p>
        </ConfirmModal>
      )}
      {selected && (
        <ConnectionEditorModal
          connection={selected}
          chosenEnvironment={environment}
          setEnv={setEnvironment}
          creating={creating}
          workspace={workspace}
          refresh={refresh}
          onCreated={onCreated}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}
