import { ArrowRight, Variable, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { nodeInterface } from "./graph";
import { useT } from "./i18n";
import { ConfirmModal, FormModal } from "./modals";
import { localDefinitions } from "./nodeCode";
import { displayNodeName } from "./nodeNames";
import { baseType, typeOptions } from "./parameterType";
import Select from "./Select";
import type { Environment, Json, Snapshot } from "./types";
import { useRevisionDraft } from "./useRevisionDraft";
import { ValueSourceFields } from "./ValueSourceFields";
import { VariableValueInput } from "./VariableFields";
import {
  changedEnvironments,
  declarations,
  descendants,
  fill,
  formatVariableValue,
  initialValue,
  looksSecret,
  sameValue,
  VARIABLE_TYPES,
  variableNameError,
  variableProblems,
  variableSummary,
  type Declaration,
} from "./variables";

export type Declarations = Record<string, Declaration>;

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
  ...(draft.from ? { from: draft.from } : {}),
  ...(!draft.from && draft.default !== undefined
    ? { default: draft.default }
    : {}),
  ...(!draft.from && Object.keys(draft.environments || {}).length
    ? { environments: draft.environments }
    : {}),
});

export function VariableEditor({
  name,
  initialName,
  readOnly,
  snapshot,
  environment,
  environments,
  onSave,
  onRename,
  onOpenNode,
  onRunSource,
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
  onRunSource?: (node: string) => void;
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
    {
      // Compare what would be saved, so switching modes back and forth is no edit.
      equal: (a, b) => a.name === b.name && sameValue(stored(a), stored(b)),
    },
  );
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const [options, setOptions] = useState(() =>
    typeOptions(draft.type).join(", "),
  );
  const values = draft.environments || {};
  const kind = baseType(draft.type);
  const problems = variableProblems(draft, name, taken, t);
  const set = (change: Partial<Draft>) =>
    update((current) => ({ ...current, ...change }));
  const setEnvironment = (key: string, item: Json | undefined) =>
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
        <label className="field">
          <span>{t("variableMode")}</span>
          <Select
            aria-label={t("variableMode")}
            value={draft.from ? "computed" : "ordinary"}
            onChange={(e) => {
              const computed = e.target.value === "computed";
              // Values stay in the draft, so switching back restores them;
              // stored() leaves them out of a computed declaration.
              update(({ from: _from, ...current }) =>
                computed
                  ? {
                      ...current,
                      from: saved?.from ?? { node: "", column: "" },
                    }
                  : current,
              );
            }}
          >
            <option value="ordinary">{t("ordinaryVariable")}</option>
            <option value="computed">{t("computedFromNode")}</option>
          </Select>
        </label>
        {draft.from ? (
          <>
            <ValueSourceFields
              snapshot={snapshot}
              value={draft.from}
              onChange={(from) => set({ from })}
            />
            <p className="muted small">{t("computedVariableHint")}</p>
            {onRunSource && saved?.from && !dirty && (
              <button
                type="button"
                className="button secondary small"
                onClick={() => onRunSource(saved.from!.node)}
              >
                {t("runNode")} ·{" "}
                {nodes.find((node) => node.id === saved.from!.node)?.label ||
                  saved.from.node}
              </button>
            )}
          </>
        ) : (
          <>
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
                  <span
                    className="variable-environment-name"
                    title={item.label}
                  >
                    <span
                      className="env-dot"
                      style={{ background: item.color }}
                    />
                    {item.id}
                  </span>
                  <VariableValueInput
                    type={draft.type}
                    value={inherited ? undefined : values[item.id]}
                    label={fill(t("environmentValue"), {
                      environment: item.id,
                    })}
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
          </>
        )}
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
                  localDefinitions(snapshot),
                ).parameters.find((item) => item.name === usage.param)?.type
              : undefined;
            return (
              <button
                key={`${usage.node}:${usage.param}`}
                className="variable-usage-row"
                onClick={() => onOpenNode(usage.node)}
              >
                <span className="grow">
                  <strong title={usage.node}>
                    {displayNodeName(usage.name, usage.label, t)}
                  </strong>
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
            const problem = variableNameError(
              values.name,
              taken.filter((item) => item !== name),
              t,
            );
            if (problem) throw new Error(problem);
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
