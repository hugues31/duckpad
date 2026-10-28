import Select from "./Select";
import { useRef, useState } from "react";
import ParameterInput from "./ParameterInput";
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
  const [selected, setSelectedState] = useState<Json | null>(null);
  const selectedRef = useRef<Json | null>(null);
  const setSelected = (value: Json | null) => {
    selectedRef.current = value;
    setSelectedState(value);
  };
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
  const changeValue = (name: string, value: any) => {
    const old = selectedRef.current!;
    const values = { ...old.environments?.[env] };
    if (value === undefined) delete values[name];
    else values[name] = value;
    setSelected({
      ...old,
      environments: {
        ...old.environments,
        [env]: values,
      },
    });
  };
  return (
    <section>
      <div className="page-heading">
        <div>
          <h2>{t("connections")}</h2>
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
              {catalog.environment_details
                .filter((e) =>
                  Object.values(connection.environments[e.id] ?? {}).some(
                    (value) =>
                      value != null &&
                      (typeof value !== "string" || value.trim() !== ""),
                  ),
                )
                .map((e) => (
                  <span key={e.id} className="env-badge">
                    <span className="env-dot" style={{ background: e.color }} />
                    {e.label}
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
              // Enter can submit a form while a parameter still has focus.
              const active = document.activeElement;
              if (
                active instanceof HTMLElement &&
                e.currentTarget.contains(active)
              )
                active.blur();
              if (!e.currentTarget.reportValidity()) return;
              void run(async () => {
                const data = structuredClone(selectedRef.current!);
                for (const environment of Object.keys(data.environments)) {
                  for (const parameter of definition?.parameters || []) {
                    if (
                      parameter.type !== "number" &&
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
                <Select
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
                </Select>
              </label>
              <div className="tabs">
                {catalog.environment_details.map((e) => (
                  <button
                    type="button"
                    key={e.id}
                    className={e.id === env ? "active" : ""}
                    aria-pressed={e.id === env}
                    onClick={() => setEnv(e.id)}
                  >
                    <span className="env-dot" style={{ background: e.color }} />
                    {e.label}
                  </button>
                ))}
              </div>
              {definition?.parameters.map((p: Json) => (
                <label
                  className="field"
                  key={`${selected.connector}:${env}:${p.name}`}
                >
                  <span>
                    {p.secret && <KeyRound size={12} />} {p.name}
                  </span>
                  {p.type === "boolean" ? (
                    <Select
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
                    </Select>
                  ) : p.type === "number" ? (
                    <ParameterInput
                      kind="number"
                      secret={p.secret}
                      value={
                        selected.environments?.[env]?.[p.name] ?? p.default
                      }
                      onChange={(value) => changeValue(p.name, value)}
                    />
                  ) : (
                    <input
                      type={p.secret ? "password" : "text"}
                      value={
                        selected.environments?.[env]?.[p.name] ??
                        p.default ??
                        ""
                      }
                      onChange={(e) => changeValue(p.name, e.target.value)}
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
