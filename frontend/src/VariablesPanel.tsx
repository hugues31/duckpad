import {
  AlertCircle,
  Plus,
  Search,
  TriangleAlert,
  Variable,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { useSearchParams } from "react-router";
import { useT } from "./i18n";
import { ConfirmModal } from "./modals";
import { displayNodeName } from "./nodeNames";
import { baseType } from "./parameterType";
import type { Environment, Snapshot, VariableSummary } from "./types";
import { Declarations, VariableEditor } from "./VariableEditor";
import {
  computedDiagnostic,
  fill,
  formatVariableValue,
  VARIABLES_FILE,
  variableSummary,
} from "./variables";

export default function VariablesPanel({
  readOnly,
  snapshot,
  environment,
  environments,
  onSave,
  onRename,
  onOpenNode,
  onViewFiles,
  onRunSource,
}: {
  readOnly: boolean;
  snapshot: Snapshot;
  environment: string;
  environments: Environment[];
  /** Change the declarations on top of the given revision, in one save. */
  onSave: (
    base: Snapshot,
    change: (variables: Declarations) => void,
  ) => Promise<Snapshot>;
  /** Rename a variable and every reference to it, in one commit. */
  onRename: (name: string, target: string) => Promise<void>;
  onOpenNode: (node: string) => void;
  onViewFiles: () => void;
  onRunSource?: (node: string) => void;
}) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const requested = params.get("variable");
  const [selected, setSelected] = useState<string | null>(requested);
  // A new variable, optionally named after an undeclared reference.
  const [creating, setCreating] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const summary = snapshot.variables;
  const declared = Object.entries(summary?.declarations || {});
  const shown = declared.filter(([name, variable]) =>
    `${name} ${variable.description}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const editable = !readOnly && !summary?.file_error;
  /** Show a variable or the creation editor, asking first before discarding edits. */
  const open = (
    name: string | null,
    create: string | null = null,
    discard = false,
  ) => {
    const go = () => {
      setDirty(false);
      setSelected(name);
      setCreating(create);
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (name) next.set("variable", name);
          else next.delete("variable");
          return next;
        },
        { replace: true },
      );
    };
    if (dirty && !discard) setLeaving(() => go);
    else go();
  };
  const receiveRequest = useEffectEvent((name: string | null) => {
    if (name === selected) return;
    open(name);
    if (dirty) {
      // Keep the URL on the active draft until the user confirms the switch.
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (selected) next.set("variable", selected);
          else next.delete("variable");
          return next;
        },
        { replace: true },
      );
    }
  });
  useEffect(() => {
    // URL navigation must use the same confirmation as a click in the variable list.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- may restore the URL
    receiveRequest(requested);
  }, [requested]);
  const editing =
    creating !== null
      ? null
      : selected && variableSummary(snapshot, selected)
        ? selected
        : null;
  const active = environments.find((item) => item.id === environment);
  return (
    <section className="full-panel variables-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("variables")}</span>
          <h1>{t("projectVariables")}</h1>
          <p>{t("variablesIntro")}</p>
        </div>
        {!readOnly && (
          <button
            className="button primary"
            disabled={!editable}
            onClick={() => open(null, "")}
          >
            <Plus size={15} />
            {t("newVariable")}
          </button>
        )}
      </div>
      {summary?.file_error && (
        <div className="notice error" role="alert">
          <strong>{VARIABLES_FILE}</strong> · {summary.file_error}{" "}
          <button className="text-button" onClick={onViewFiles}>
            {t("viewFiles")}
          </button>
        </div>
      )}
      {Object.entries(summary?.undeclared || {}).map(([name, usages]) => (
        <div className="notice warning" key={name}>
          {fill(t("undeclaredVariableUsed"), {
            name,
            nodes: usages
              .map((usage) => displayNodeName(usage.name, usage.label, t))
              .join(", "),
          })}{" "}
          {editable && (
            <button className="text-button" onClick={() => open(null, name)}>
              {t("declareVariable")}
            </button>
          )}
        </div>
      ))}
      <div
        className={`variables-layout ${editing || creating !== null ? "editing" : ""}`}
      >
        <div className="variables-main">
          <div className="variables-tools">
            <label className="search">
              <Search size={13} />
              <input
                aria-label={t("findVariable")}
                placeholder={t("findVariable")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <span className="muted small">
              {fill(
                t(
                  declared.length === 1 ? "variableCountOne" : "variablesCount",
                ),
                {
                  count: declared.length,
                  environment: active?.label || environment,
                },
              )}
            </span>
          </div>
          {declared.length ? (
            <div className="variables-table-scroll">
              <table className="variables-table">
                <thead>
                  <tr>
                    <th>{t("variableName")}</th>
                    <th>{t("variableType")}</th>
                    <th>{t("defaultValue")}</th>
                    {environments.map((item) => (
                      <th
                        key={item.id}
                        className={
                          item.id === environment ? "active-environment" : ""
                        }
                        aria-current={
                          item.id === environment ? "true" : undefined
                        }
                      >
                        <span
                          className="env-dot"
                          style={{ background: item.color }}
                        />
                        {item.id}
                      </th>
                    ))}
                    <th>{t("usedBy")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(([name, variable]) => (
                    <VariableRow
                      key={name}
                      name={name}
                      variable={variable}
                      environments={environments}
                      environment={environment}
                      selected={name === editing}
                      onSelect={() => open(name)}
                    />
                  ))}
                </tbody>
              </table>
              {!shown.length && <p className="empty-small">{t("noMatches")}</p>}
            </div>
          ) : (
            !summary?.file_error && (
              <div className="empty-state variables-empty">
                <Variable size={28} />
                <h3>{t("noVariables")}</h3>
                <p>{t("noVariablesHint")}</p>
              </div>
            )
          )}
          <p className="muted small">{t("variablesNotSecret")}</p>
        </div>
        {(editing || creating !== null) && (
          <VariableEditor
            key={editing ?? `new:${creating}`}
            name={editing}
            initialName={creating ?? ""}
            readOnly={!editable}
            snapshot={snapshot}
            environment={environment}
            environments={environments}
            onSave={onSave}
            onRename={async (target) => {
              await onRename(editing!, target);
              open(target);
            }}
            onOpenNode={onOpenNode}
            onRunSource={onRunSource}
            onDirty={setDirty}
            onCreated={(name) => open(name, null, true)}
            onClose={() => open(null)}
          />
        )}
      </div>
      {leaving && (
        <ConfirmModal
          title={t("unsavedChanges")}
          confirmLabel={t("discardChanges")}
          onConfirm={async () => leaving()}
          onClose={() => setLeaving(null)}
        >
          <p>{t("discardVariableHint")}</p>
        </ConfirmModal>
      )}
    </section>
  );
}

function VariableRow({
  name,
  variable,
  environments,
  environment,
  selected,
  onSelect,
}: {
  name: string;
  variable: VariableSummary;
  environments: Environment[];
  environment: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  const problems = [...variable.errors, ...variable.warnings];
  const count = new Set(variable.usages.map((usage) => usage.node)).size;
  return (
    <tr
      className={selected ? "selected" : ""}
      aria-selected={selected}
      onClick={onSelect}
    >
      <td>
        <button
          className="variable-name"
          aria-pressed={selected}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
        >
          <code>{name}</code>
          {!!problems.length &&
            (variable.errors.length ? (
              <AlertCircle
                size={13}
                className="variable-error"
                aria-label={problems.join(" ")}
              />
            ) : (
              <TriangleAlert
                size={13}
                className="variable-warning"
                aria-label={problems.join(" ")}
              />
            ))}
        </button>
        {variable.description && <small>{variable.description}</small>}
      </td>
      <td>
        <span className="badge neutral" title={variable.type}>
          {baseType(variable.type)}
        </span>
      </td>
      <td className="variable-value">
        {variable.from ? (
          <>
            <span>{t("computedFromNode")}</span>
            <small>
              {[variable.from.node, variable.from.port, variable.from.column]
                .filter(Boolean)
                .join(".")}
            </small>
          </>
        ) : "default" in variable ? (
          formatVariableValue(variable.default)
        ) : (
          "—"
        )}
      </td>
      {environments.map((item) => {
        const value = variable.values[item.id];
        return (
          <td
            key={item.id}
            className={`variable-value ${item.id === environment ? "active-environment" : ""}`}
          >
            {!value || value.error ? (
              <span className="variable-error" title={value?.error}>
                {computedDiagnostic(value?.code, t) || t("noVariableValue")}
                {value?.last_error && <small>{value.last_error}</small>}
              </span>
            ) : value.source === "default" ? (
              <span className="muted">{t("defaultValueSource")}</span>
            ) : (
              <span title={value.producer_run}>
                {formatVariableValue(value.value)}
                {value.resolution === "retained" && (
                  <small>{t("retainedValue")}</small>
                )}
                {value.source_stale && <small>{t("valueSourceStale")}</small>}
                {value.last_error && (
                  <small className="variable-error">{value.last_error}</small>
                )}
              </span>
            )}
          </td>
        );
      })}
      <td className={count ? "variable-usage" : "muted"}>
        {count
          ? fill(t(count === 1 ? "usedByOne" : "usedByMany"), { count })
          : t("notUsed")}
      </td>
    </tr>
  );
}
