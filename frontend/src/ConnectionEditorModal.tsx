import { KeyRound, PlugZap } from "lucide-react";
import { useRef, useState } from "react";
import { api, errorDetail, send } from "./api";
import { FAMILIES, familyOf } from "./connectionFamilies";
import { useT } from "./i18n";
import { ModalForm } from "./modals";
import ParameterInput from "./ParameterInput";
import SecretInput from "./SecretInput";
import Select from "./Select";
import type { Connection, ConnectionTest, Json, Workspace } from "./types";

export default function ConnectionEditorModal({
  connection,
  chosenEnvironment,
  setEnv,
  creating,
  workspace,
  refresh,
  onCreated,
  onClose,
}: {
  connection: Connection;
  chosenEnvironment: string;
  setEnv: (environment: string) => void;
  creating: boolean;
  workspace: Workspace;
  refresh: () => Promise<void>;
  onCreated?: (connection: Connection) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [selected, setSelectedState] = useState<Connection>(connection);
  const selectedRef = useRef<Connection>(connection);
  const setSelected = (value: Connection) => {
    selectedRef.current = value;
    setSelectedState(value);
  };
  const { catalog } = workspace;
  // Environments can be deleted in the settings; fall back to the first one.
  const env = catalog.environments.includes(chosenEnvironment)
    ? chosenEnvironment
    : catalog.environments[0];
  // The test of the form's values in one environment. Editing them, or switching environment
  // or connection, drops it, and the answer of a test still running is then ignored.
  const [test, setTest] = useState<{
    environment: string;
    result?: ConnectionTest;
    error?: string;
  } | null>(null);
  const testAttempt = useRef(0);
  const connectorOf = (id?: string) =>
    catalog.connectors.find((c) => c.id === id);
  const definition = connectorOf(selected?.connector);
  const label = (id: string) =>
    catalog.environment_details.find((e) => e.id === id)?.label ?? id;
  const resetTest = () => {
    testAttempt.current += 1;
    setTest(null);
  };
  const testConnection = () => {
    resetTest();
    const attempt = testAttempt.current;
    const environment = env;
    const settle = (outcome: { result?: ConnectionTest; error?: string }) => {
      if (testAttempt.current === attempt) setTest({ environment, ...outcome });
    };
    setTest({ environment });
    api<ConnectionTest>(
      "/catalog/connection/test",
      send({ connection: selectedRef.current, environment }),
    ).then(
      (result) => settle({ result }),
      (e: unknown) => settle({ error: (e as Error).message }),
    );
  };
  const testing = test !== null && !test.result && test.error === undefined;
  const changeValue = (name: string, value: Json | undefined) => {
    resetTest();
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
    <ModalForm
      title={selected.name || t("newConnection")}
      onClose={onClose}
      submitLabel={t("save")}
      onSubmit={async (form) => {
        // Enter can submit a form while a parameter still has focus.
        const active = document.activeElement;
        if (active instanceof HTMLElement && form.contains(active))
          active.blur();
        if (!form.reportValidity()) return false;

        const data = structuredClone(selectedRef.current!);
        for (const environment of Object.keys(data.environments)) {
          for (const parameter of definition?.parameters || []) {
            if (
              parameter.type !== "number" &&
              data.environments[environment][parameter.name] === undefined &&
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

        if (creating) await onCreated?.(data);
      }}
      actions={({ pending: saving }) => (
        <button
          type="button"
          className="button secondary small"
          disabled={saving || testing}
          onClick={testConnection}
        >
          <PlugZap size={14} />
          {t(testing ? "testingConnection" : "testConnection")}
        </button>
      )}
    >
      {({ pending: saving }) => (
        <>
          <label className="field">
            <span>{t("identifier")}</span>
            <input
              aria-label={t("identifier")}
              aria-describedby="connection-identifier-hint"
              required
              pattern="[a-zA-Z][a-zA-Z0-9_-]*"
              disabled={!creating || saving}
              value={selected.id}
              onChange={(e) => setSelected({ ...selected, id: e.target.value })}
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
                resetTest();
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
                onClick={() => {
                  setEnv(e.id);
                  resetTest();
                }}
              >
                <span className="env-dot" style={{ background: e.color }} />
                {e.label}
              </button>
            ))}
          </div>
          {definition?.parameters?.map((p) => {
            const name = p.label || p.name;
            // The description stays out of the accessible name.
            const hint = p.description
              ? `connection-parameter-${p.name}-hint`
              : undefined;
            // A secret has two controls, a source and a value, each with its own label.
            const Field =
              p.secret && p.type !== "boolean" && p.type !== "number"
                ? "div"
                : "label";
            return (
              <Field
                className="field"
                key={`${selected.connector}:${env}:${p.name}`}
              >
                <span>
                  {p.secret && <KeyRound size={12} />} {name}
                </span>
                {p.type === "boolean" ? (
                  <Select
                    aria-label={name}
                    aria-describedby={hint}
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
                    label={name}
                    disabled={saving}
                    secret={p.secret}
                    value={selected.environments?.[env]?.[p.name] ?? p.default}
                    onChange={(value) => changeValue(p.name, value)}
                  />
                ) : p.secret ? (
                  <SecretInput
                    label={name}
                    hint={hint}
                    disabled={saving}
                    value={selected.environments?.[env]?.[p.name] ?? p.default}
                    saved={
                      creating
                        ? undefined
                        : catalog.connections.find((c) => c.id === selected.id)
                            ?.environments?.[env]?.[p.name]
                    }
                    onChange={(value) => changeValue(p.name, value)}
                  />
                ) : (
                  <input
                    aria-label={name}
                    aria-describedby={hint}
                    disabled={saving}
                    value={String(
                      selected.environments?.[env]?.[p.name] ?? p.default ?? "",
                    )}
                    onChange={(e) => changeValue(p.name, e.target.value)}
                  />
                )}
                {hint && (
                  <small className="muted" id={hint}>
                    {p.description}
                  </small>
                )}
              </Field>
            );
          })}
          <p className="muted small">{t("secretHint")}</p>
          <p className="muted small">{t("connectionTestHint")}</p>

          {test?.result && (
            <div className="notice success" role="status">
              {test.result.schemas
                ? t("connectionTestPassed")
                    .replace("{environment}", label(test.environment))
                    .replace("{schemas}", String(test.result.schemas.length))
                    .replace(
                      "{tables}",
                      String(test.result.tables?.length ?? 0),
                    )
                : t("connectionTestReady").replace(
                    "{environment}",
                    label(test.environment),
                  )}
            </div>
          )}
          {test?.error && (
            <div className="notice error connection-test-error" role="alert">
              {test.error}
            </div>
          )}
        </>
      )}
    </ModalForm>
  );
}
