import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import {
  AlertCircle,
  ArrowRight,
  Plus,
  Search,
  TriangleAlert,
  Variable,
  X,
} from "lucide-react";
import { nodeInterface } from "./graph";
import { useT } from "./i18n";
import { ConfirmModal, FormModal } from "./modals";
import Select from "./Select";
import type { Environment, Snapshot, VariableSummary } from "./types";
import { useRevisionDraft } from "./useRevisionDraft";
import { VariableValueInput } from "./VariableFields";
import {
  baseType,
  changedEnvironments,
  declarations,
  descendants,
  fill,
  formatVariableValue,
  initialValue,
  looksSecret,
  sameValue,
  typeOptions,
  validValue,
  variableSummary,
  VARIABLE_NAME,
  VARIABLE_TYPES,
  VARIABLES_FILE,
  type Declaration,
} from "./variables";

type Declarations = Record<string, Declaration>;
/** A declaration being edited, with the name it is or will be saved under. */
type Draft = Declaration & { name: string };

const NEW_VARIABLE: Draft = {
  name: "",
  type: "text",
  description: "",
  default: "",
  environments: {},
};

/** A draft as variables.json stores it, without empty optional fields. */
const stored = ({ name: _name, ...draft }: Draft): Declaration => ({
  type: draft.type,
  ...(draft.description ? { description: draft.description } : {}),
  ...(draft.default !== undefined ? { default: draft.default } : {}),
  ...(Object.keys(draft.environments || {}).length
    ? { environments: draft.environments }
    : {}),
});

export default function VariablesPanel({
  readOnly,
  snapshot,
  environment,
  environments,
  onSave,
  onRename,
  onOpenNode,
  onViewFiles,
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
  onRename: (base: Snapshot, name: string, target: string) => Promise<void>;
  onOpenNode: (node: string) => void;
  onViewFiles: () => void;
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
  useEffect(() => {
    if (requested) {
      setSelected(requested);
      setCreating(null);
    }
  }, [requested]);
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
            nodes: usages.map((usage) => usage.label).join(", "),
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
              await onRename(snapshot, editing!, target);
              open(target);
            }}
            onOpenNode={onOpenNode}
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
        {"default" in variable ? formatVariableValue(variable.default) : "—"}
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
                {t("noVariableValue")}
              </span>
            ) : value.source === "default" ? (
              <span className="muted">{t("defaultValueSource")}</span>
            ) : (
              formatVariableValue(value.value)
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

function VariableEditor({
  name,
  initialName,
  readOnly,
  snapshot,
  environment,
  environments,
  onSave,
  onRename,
  onOpenNode,
  onDirty,
  onCreated,
  onClose,
}: {
  /** The variable edited, or null for a new one. */
  name: string | null;
  initialName: string;
  readOnly: boolean;
  snapshot: Snapshot;
  environment: string;
  environments: Environment[];
  onSave: (
    base: Snapshot,
    change: (variables: Declarations) => void,
  ) => Promise<Snapshot>;
  onRename: (target: string) => Promise<void>;
  onOpenNode: (node: string) => void;
  onDirty: (dirty: boolean) => void;
  onCreated: (name: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const saved = name ? declarations(snapshot.bundle)?.[name] : undefined;
  const summary = name ? variableSummary(snapshot, name) : undefined;
  const value = useMemo<Draft>(
    () =>
      saved && name
        ? {
            environments: {},
            ...saved,
            type: summary?.type || saved.type,
            name,
          }
        : { ...NEW_VARIABLE, name: initialName },
    [saved, summary?.type, name, initialName],
  );
  const taken = Object.keys(snapshot.variables?.declarations || {});
  const [message, setMessage] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { draft, update, persist, pending, dirty } = useRevisionDraft<
    Draft,
    Snapshot
  >(
    value,
    snapshot,
    async (draft, base) => {
      const result = await onSave(base, (variables) => {
        if (!name && Object.hasOwn(variables, draft.name))
          throw new Error(t("variableExists"));
        variables[draft.name] = stored(draft);
      });
      if (!name) onCreated(draft.name);
      return result;
    },
    { equal: sameValue },
  );
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const [options, setOptions] = useState(() =>
    typeOptions(draft.type).join(", "),
  );
  const values = draft.environments || {};
  const kind = baseType(draft.type);
  const choices = typeOptions(draft.type);
  const problems = [
    !name &&
      draft.name &&
      !VARIABLE_NAME.test(draft.name) &&
      t("invalidVariableName"),
    !name && taken.includes(draft.name) && t("variableExists"),
    kind === "choice" &&
      (!choices.length ||
        choices.some((option) => !option || /[()]/.test(option)) ||
        new Set(choices).size !== choices.length) &&
      t("choiceOptionsRequired"),
    draft.default !== undefined &&
      !validValue(draft.type, draft.default) &&
      `${t("defaultValue")}: ${fill(t("invalidVariableValue"), { type: draft.type })}`,
    ...Object.entries(values)
      .filter(([, item]) => !validValue(draft.type, item))
      .map(
        ([key]) =>
          `${key}: ${fill(t("invalidVariableValue"), { type: draft.type })}`,
      ),
  ].filter(Boolean) as string[];
  const set = (change: Partial<Draft>) =>
    update((current) => ({ ...current, ...change }));
  const setEnvironment = (key: string, item: unknown) =>
    update((current) => {
      const next = { ...current.environments };
      if (item === undefined) delete next[key];
      else next[key] = item;
      return { ...current, environments: next };
    });
  const usages = summary?.usages || [];
  const nodes = snapshot.bundle?.flow.nodes || [];
  const usedNodes = [...new Set(usages.map((usage) => usage.node))];
  const changed = saved
    ? changedEnvironments(
        saved,
        stored(draft),
        environments.map((item) => item.id),
      )
    : [];
  const downstream = snapshot.bundle
    ? descendants(snapshot.bundle, usedNodes).size
    : 0;
  const unknown = Object.keys(values).filter(
    (key) => !environments.some((item) => item.id === key),
  );
  const save = async () => {
    setMessage("");
    try {
      await persist();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };
  return (
    <aside className="variable-editor" aria-label={name || t("newVariable")}>
      <header>
        <Variable size={15} />
        <strong>{name || t("newVariable")}</strong>
        <button className="icon" title={t("close")} onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <p className="muted small">{t("variableEditorHint")}</p>
      {summary?.errors.map((error) => (
        <p className="notice error" key={error}>
          {error}
        </p>
      ))}
      {summary?.warnings.map((warning) => (
        <p className="notice warning" key={warning}>
          {warning}
        </p>
      ))}
      <fieldset className="readonly-fields" disabled={readOnly || pending}>
        <div className="variable-editor-row">
          <label className="field">
            <span>{t("variableName")}</span>
            <input
              className="code-input"
              value={draft.name}
              readOnly={!!name}
              autoFocus={!name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>{t("variableType")}</span>
            <Select
              aria-label={t("variableType")}
              value={kind === "list" ? draft.type : kind}
              onChange={(e) => {
                const type =
                  e.target.value === "choice"
                    ? `choice(${options
                        .split(",")
                        .map((option) => option.trim())
                        .filter(Boolean)
                        .join("|")})`
                    : e.target.value;
                set({ type });
              }}
            >
              {VARIABLE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {!name && looksSecret(draft.name) && (
          <p className="notice warning">{t("secretVariableWarning")}</p>
        )}
        {kind === "choice" && (
          <label className="field">
            <span>{t("choiceOptions")}</span>
            <input
              value={options}
              placeholder="paid, refunded, pending"
              onChange={(e) => {
                setOptions(e.target.value);
                set({
                  type: `choice(${e.target.value
                    .split(",")
                    .map((option) => option.trim())
                    .filter(Boolean)
                    .join("|")})`,
                });
              }}
            />
          </label>
        )}
        <label className="field">
          <span>{t("variableDescription")}</span>
          <textarea
            rows={2}
            value={draft.description || ""}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
        <div className="field">
          <span>
            <label htmlFor={`${id}-default`}>{t("defaultValue")}</label>
          </span>
          <VariableValueInput
            id={`${id}-default`}
            type={draft.type}
            value={draft.default}
            placeholder={t("noDefault")}
            onChange={(item) =>
              update((current) => {
                const next = { ...current };
                if (item === undefined) delete next.default;
                else next.default = item;
                return next;
              })
            }
          />
        </div>
        <h4 className="eyebrow">{t("valuePerEnvironment")}</h4>
        {environments.map((item) => {
          const inherited = !(item.id in values);
          return (
            <div
              className={`variable-environment ${item.id === environment ? "active" : ""}`}
              key={item.id}
            >
              <span className="variable-environment-name" title={item.label}>
                <span className="env-dot" style={{ background: item.color }} />
                {item.id}
              </span>
              <VariableValueInput
                type={draft.type}
                value={inherited ? undefined : values[item.id]}
                label={fill(t("environmentValue"), { environment: item.id })}
                disabled={inherited}
                placeholder={
                  draft.default === undefined
                    ? t("noVariableValue")
                    : `${formatVariableValue(draft.default)} · ${t("defaultValueSource")}`
                }
                onChange={(next) => setEnvironment(item.id, next)}
              />
              <label className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={fill(t("useDefaultIn"), {
                    environment: item.id,
                  })}
                  checked={inherited}
                  onChange={(e) =>
                    setEnvironment(
                      item.id,
                      e.target.checked
                        ? undefined
                        : (draft.default ?? initialValue(draft.type)),
                    )
                  }
                />
                <span aria-hidden="true">{t("defaultValueSource")}</span>
              </label>
            </div>
          );
        })}
        {unknown.map((key) => (
          <div className="variable-environment unknown" key={key}>
            <span className="variable-environment-name">{key}</span>
            <span className="variable-warning">
              {formatVariableValue(values[key])} · {t("unknownEnvironment")}
            </span>
            <button
              type="button"
              className="text-button danger"
              onClick={() => setEnvironment(key, undefined)}
            >
              {t("remove")}
            </button>
          </div>
        ))}
      </fieldset>
      {name && dirty && (
        <p className="variable-impact" role="status">
          {!changed.length
            ? t("impactNone")
            : !usedNodes.length
              ? t("impactUnused")
              : fill(
                  t(
                    downstream > 1
                      ? "impactStaleDescendants"
                      : downstream
                        ? "impactStaleDescendant"
                        : "impactStale",
                  ),
                  {
                    nodes: usedNodes
                      .map(
                        (node) =>
                          usages.find((usage) => usage.node === node)!.label,
                      )
                      .join(", "),
                    count: downstream,
                    environments: changed.join(", "),
                  },
                )}
        </p>
      )}
      {(problems.length > 0 && (dirty || !name)) || message ? (
        <div className="notice error" role="alert">
          {[...(dirty || !name ? problems : []), message]
            .filter(Boolean)
            .map((text) => (
              <div key={text}>{text}</div>
            ))}
        </div>
      ) : null}
      {name && (
        <>
          <h4 className="eyebrow">{t("usedBy")}</h4>
          {!usages.length && <p className="muted small">{t("notUsed")}</p>}
          {usages.map((usage) => {
            const node = nodes.find((item) => item.id === usage.node);
            const type = node
              ? nodeInterface(
                  node,
                  snapshot.parsed_templates,
                  snapshot.bundle?.components,
                ).parameters.find((item) => item.name === usage.param)?.type
              : undefined;
            return (
              <button
                key={`${usage.node}:${usage.param}`}
                className="variable-usage-row"
                onClick={() => onOpenNode(usage.node)}
              >
                <span className="grow">
                  <strong>{usage.label}</strong>
                  <small>
                    {usage.param}
                    {type ? ` · ${type}` : ""}
                  </small>
                </span>
                <ArrowRight size={14} />
              </button>
            );
          })}
        </>
      )}
      {!readOnly && (
        <div className="variable-actions">
          <button
            className="button primary small"
            disabled={
              pending || !!problems.length || (name ? !dirty : !draft.name)
            }
            onClick={save}
          >
            {t(pending ? "saving" : name ? "save" : "create")}
          </button>
          {name ? (
            <>
              <button
                className="button secondary small"
                disabled={pending || dirty}
                title={dirty ? t("saveBeforeRename") : undefined}
                onClick={() => setRenaming(true)}
              >
                {t("renameVariableAction")}
              </button>
              <button
                className="button secondary small danger"
                disabled={pending || usages.length > 0}
                title={
                  usages.length ? t("deleteUsedVariable") : t("deleteVariable")
                }
                onClick={() => setDeleting(true)}
              >
                {t("delete")}
              </button>
            </>
          ) : (
            <button className="button secondary small" onClick={onClose}>
              {t("cancel")}
            </button>
          )}
        </div>
      )}
      {renaming && name && (
        <FormModal
          title={t("renameVariable")}
          description={t("renameVariableHint")}
          submitLabel={t("rename")}
          fields={[{ key: "name", label: t("variableName"), value: name }]}
          onSubmit={async (values) => {
            if (!VARIABLE_NAME.test(values.name))
              throw new Error(t("invalidVariableName"));
            await onRename(values.name);
          }}
          onClose={() => setRenaming(false)}
        />
      )}
      {deleting && name && (
        <ConfirmModal
          title={t("deleteVariable")}
          confirmLabel={t("delete")}
          onConfirm={async () => {
            await onSave(snapshot, (variables) => {
              delete variables[name];
            });
            onClose();
          }}
          onClose={() => setDeleting(false)}
        >
          <p>{fill(t("deleteVariableHint"), { name })}</p>
        </ConfirmModal>
      )}
    </aside>
  );
}
