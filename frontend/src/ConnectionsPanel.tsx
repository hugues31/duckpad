import Select from "./Select";
import { useRef, useState } from "react";
import ParameterInput from "./ParameterInput";
import {
  Copy,
  Database,
  FolderOpen,
  KeyRound,
  Plus,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { api, errorDetail, send } from "./api";
import { useT } from "./i18n";
import { ConfirmModal, Modal } from "./modals";
import type {
  Connection,
  Connector,
  ConnectorFamily,
  Json,
  Workspace,
} from "./types";
import { useAsyncAction } from "./useAsyncAction";

const FAMILIES = [
  { family: "database", label: "databasesAndWarehouses", icon: Database },
  { family: "storage", label: "fileStorage", icon: FolderOpen },
] as const;

/** Definitions without the storage family are databases: the catalog accepts no other family. */
const familyOf = (connector?: Connector): ConnectorFamily =>
  connector?.family === "storage" ? "storage" : "database";

/** The definition as the administrator edits it, without the listing's origin. */
function definitionText(connector: Connector) {
  const { origin: _, ...definition } = connector;
  return JSON.stringify(definition, null, 2);
}

export default function ConnectionsPanel({
  workspace,
  refresh,
  onEditor,
}: {
  workspace: Workspace;
  refresh: () => Promise<void>;
  onEditor: (data: { title: string; value: string; create?: boolean }) => void;
}) {
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<Connector | null>(null);
  const [selected, setSelectedState] = useState<Connection | null>(null);
  const selectedRef = useRef<Connection | null>(null);
  const setSelected = (value: Connection | null) => {
    selectedRef.current = value;
    setSelectedState(value);
  };
  const { catalog } = workspace;
  const [chosenEnvironment, setEnv] = useState("");
  // Environments can be deleted in the settings; fall back to the first one.
  const env = catalog.environments.includes(chosenEnvironment)
    ? chosenEnvironment
    : catalog.environments[0];
  const { pending: saving, error, setError, run } = useAsyncAction();
  const connectorOf = (id?: string) =>
    catalog.connectors.find((c) => c.id === id);
  const definition = connectorOf(selected?.connector);
  const changeValue = (name: string, value: Json | undefined) => {
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
          onClick={() => {
            setCreating(true);
            setError("");
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
                      setError("");
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
              create: true,
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
            .map((connector) => (
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
                    aria-label={`${t("edit")} ${connector.name ?? connector.id}`}
                    onClick={() =>
                      onEditor({
                        title: connector.name ?? connector.id,
                        value: definitionText(connector),
                      })
                    }
                  >
                    {t("edit")}
                  </button>
                  <button
                    className="button secondary small"
                    aria-label={`${t("duplicate")} ${connector.name ?? connector.id}`}
                    onClick={() =>
                      onEditor({
                        title: t("duplicateConnector"),
                        value: definitionText({
                          ...connector,
                          id: `${connector.id}_copy`,
                          name: t("copyName").replace(
                            "{name}",
                            connector.name ?? connector.id,
                          ),
                        }),
                        create: true,
                      })
                    }
                  >
                    <Copy size={14} />
                    {t("duplicate")}
                  </button>
                  {connector.origin === "customized" && (
                    <button
                      className="button secondary small"
                      aria-label={`${t("resetToBuiltIn")} ${connector.name ?? connector.id}`}
                      onClick={() => setResetting(connector)}
                    >
                      <RotateCcw size={14} />
                      {t("resetToBuiltIn")}
                    </button>
                  )}
                </div>
              </div>
            ))}
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
        <Modal
          title={selected.name || t("newConnection")}
          onClose={() => {
            if (!saving) setSelected(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (saving) return;
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
                try {
                  await api(
                    `/catalog/connection?create=${creating}`,
                    send(data, "PUT"),
                  );
                } catch (error) {
                  const { code } = errorDetail(error);
                  if (code === "connection_exists")
                    throw new Error(t("connectionAlreadyExists"), {
                      cause: error,
                    });
                  if (code === "connection_missing")
                    throw new Error(t("connectionMissing"), {
                      cause: error,
                    });
                  throw error;
                }
                await refresh();
                setSelected(null);
              });
            }}
          >
            <div className="modal-content">
              <label className="field">
                <span>{t("identifier")}</span>
                <input
                  aria-label={t("identifier")}
                  aria-describedby="connection-identifier-hint"
                  required
                  pattern="[a-zA-Z][a-zA-Z0-9_-]*"
                  disabled={!creating || saving}
                  value={selected.id}
                  onChange={(e) =>
                    setSelected({ ...selected, id: e.target.value })
                  }
                />
                <small className="muted" id="connection-identifier-hint">
                  {t("connectionIdentifierHint")}
                </small>
              </label>
              <label className="field">
                <span>{t("name")}</span>
                <input
                  required
                  disabled={saving}
                  value={selected.name}
                  onChange={(e) =>
                    setSelected({ ...selected, name: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>{t("connector")}</span>
                <Select
                  disabled={saving}
                  value={selected.connector}
                  onChange={(e) => {
                    const connector = e.target.value;
                    const parameters = new Set(
                      catalog.connectors
                        .find((c) => c.id === connector)
                        ?.parameters?.map((p) => p.name),
                    );
                    setSelected({
                      ...selected,
                      connector,
                      environments: Object.fromEntries(
                        Object.entries(selected.environments).map(
                          ([environment, values]) => [
                            environment,
                            Object.fromEntries(
                              Object.entries(values).filter(([name]) =>
                                parameters.has(name),
                              ),
                            ),
                          ],
                        ),
                      ),
                    });
                  }}
                >
                  {FAMILIES.map(({ family, label }) => (
                    <optgroup key={family} label={t(label)}>
                      {catalog.connectors
                        .filter((c) => familyOf(c) === family)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </optgroup>
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
              {definition?.parameters?.map((p) => (
                <label
                  className="field"
                  key={`${selected.connector}:${env}:${p.name}`}
                >
                  <span>
                    {p.secret && <KeyRound size={12} />} {p.name}
                  </span>
                  {p.type === "boolean" ? (
                    <Select
                      disabled={saving}
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
                      disabled={saving}
                      secret={p.secret}
                      value={
                        selected.environments?.[env]?.[p.name] ?? p.default
                      }
                      onChange={(value) => changeValue(p.name, value)}
                    />
                  ) : (
                    <input
                      disabled={saving}
                      type={p.secret ? "password" : "text"}
                      value={String(
                        selected.environments?.[env]?.[p.name] ??
                          p.default ??
                          "",
                      )}
                      onChange={(e) => changeValue(p.name, e.target.value)}
                    />
                  )}
                </label>
              ))}
              <p className="muted small">{t("secretHint")}</p>
              {error && (
                <div className="notice error" role="alert">
                  {error}
                </div>
              )}
            </div>
            <footer>
              <button
                type="button"
                className="button secondary"
                disabled={saving}
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
