import { useState } from "react";
import { Database, KeyRound, Plus, Settings2 } from "lucide-react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { Modal } from "./modals";
import type { Json, Workspace } from "./types";
import { useAsyncAction } from "./useAsyncAction";

export default function ConnectionsPanel({
  workspace,
  refresh,
  onEditor,
}: {
  workspace: Workspace;
  refresh: () => Promise<void>;
  onEditor: (data: { title: string; value: string }) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Json | null>(null);
  const { catalog } = workspace;
  const [chosenEnvironment, setEnv] = useState("");
  // Environments can be renamed in the settings; fall back to the first one.
  const env = catalog.environments.includes(chosenEnvironment)
    ? chosenEnvironment
    : catalog.environments[0];
  const { pending: saving, error, setError, run } = useAsyncAction();
  const definition = catalog.connectors.find(
    (c: Json) => c.id === selected?.connector,
  );
  const changeValue = (name: string, value: any) =>
    setSelected((old) => ({
      ...old,
      environments: {
        ...old!.environments,
        [env]: { ...old!.environments?.[env], [name]: value },
      },
    }));
  return (
    <section className="full-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("workspace")}</span>
          <h1>{t("connections")}</h1>
          <p>{t("catalogHint")}</p>
        </div>
        <button
          className="button primary"
          onClick={() =>
            setSelected({
              id: "",
              name: "",
              connector: "local",
              environments: Object.fromEntries(
                catalog.environments.map((e: string) => [e, {}]),
              ),
            })
          }
        >
          <Plus size={16} />
          {t("newConnection")}
        </button>
      </div>
      <div className="connection-grid">
        {catalog.connections.map((connection: Json) => (
          <button
            key={connection.id}
            className="connection-card"
            onClick={() => {
              setSelected(structuredClone(connection));
              setError("");
            }}
          >
            <span className="connection-logo">
              <Database size={24} />
            </span>
            <strong>{connection.name}</strong>
            <span>
              {catalog.connectors.find(
                (c: Json) => c.id === connection.connector,
              )?.name || connection.connector}
            </span>
            <div className="row gap">
              {Object.keys(connection.environments).map((e) => (
                <span key={e} className="env-badge">
                  {e}
                </span>
              ))}
            </div>
            <Settings2 size={16} className="card-corner" />
          </button>
        ))}
      </div>
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
      {catalog.connectors.map((connector: Json) => (
        <div className="connector-row" key={connector.id}>
          <div>
            <strong>{connector.name}</strong>
            <p>{connector.description}</p>
            <small>{connector.compatibility}</small>
          </div>
          <div className="row gap">
            {connector.capabilities.map((c: string) => (
              <span key={c} className="badge neutral">
                {t(c)}
              </span>
            ))}
            <button
              className="button secondary small"
              onClick={() =>
                onEditor({
                  title: connector.name,
                  value: JSON.stringify(connector, null, 2),
                })
              }
            >
              {t("edit")}
            </button>
          </div>
        </div>
      ))}
      {selected && (
        <Modal
          title={selected.name || t("newConnection")}
          onClose={() => setSelected(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const data = structuredClone(selected);
                for (const environment of Object.keys(data.environments)) {
                  for (const parameter of definition?.parameters || []) {
                    if (
                      data.environments[environment][parameter.name] ===
                        undefined &&
                      parameter.default !== undefined
                    )
                      data.environments[environment][parameter.name] =
                        parameter.default;
                  }
                }
                await api("/catalog/connection", send(data, "PUT"));
                await refresh();
                setSelected(null);
              });
            }}
          >
            <div className="modal-content">
              <label className="field">
                <span>{t("identifier")}</span>
                <input
                  required
                  pattern="[a-zA-Z][a-zA-Z0-9_-]*"
                  value={selected.id}
                  onChange={(e) =>
                    setSelected({ ...selected, id: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>{t("name")}</span>
                <input
                  required
                  value={selected.name}
                  onChange={(e) =>
                    setSelected({ ...selected, name: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>{t("connector")}</span>
                <select
                  value={selected.connector}
                  onChange={(e) =>
                    setSelected({ ...selected, connector: e.target.value })
                  }
                >
                  {catalog.connectors.map((c: Json) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="tabs">
                {catalog.environments.map((e: string) => (
                  <button
                    type="button"
                    key={e}
                    className={e === env ? "active" : ""}
                    aria-pressed={e === env}
                    onClick={() => setEnv(e)}
                  >
                    {e}
                  </button>
                ))}
              </div>
              {definition?.parameters.map((p: Json) => (
                <label className="field" key={p.name}>
                  <span>
                    {p.secret && <KeyRound size={12} />} {p.name}
                  </span>
                  {p.type === "boolean" ? (
                    <select
                      value={String(
                        selected.environments?.[env]?.[p.name] ??
                          p.default ??
                          false,
                      )}
                      onChange={(e) =>
                        changeValue(p.name, e.target.value === "true")
                      }
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      type={
                        p.secret
                          ? "password"
                          : p.type === "number"
                            ? "number"
                            : "text"
                      }
                      value={
                        selected.environments?.[env]?.[p.name] ??
                        p.default ??
                        ""
                      }
                      onChange={(e) =>
                        changeValue(
                          p.name,
                          p.type === "number"
                            ? Number(e.target.value)
                            : e.target.value,
                        )
                      }
                    />
                  )}
                </label>
              ))}
              <p className="muted small">{t("secretHint")}</p>
              {error && <div className="notice error">{error}</div>}
            </div>
            <footer>
              <button
                type="button"
                className="button secondary"
                onClick={() => setSelected(null)}
              >
                {t("cancel")}
              </button>
              <button className="button primary" disabled={saving}>
                {t(saving ? "saving" : "save")}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
}
