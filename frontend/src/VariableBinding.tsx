import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { ArrowRight, Plus, Variable, X } from "lucide-react";
import { useT } from "./i18n";
import { Modal } from "./modals";
import { worktreeUrl } from "./navigation";
import type { Json, Snapshot, VariableSummary } from "./types";
import { useAsyncAction } from "./useAsyncAction";
import { VariableValueInput } from "./VariableFields";
import {
  compatible,
  declarations,
  fill,
  formatVariableValue,
  looksSecret,
  validValue,
  variableSummary,
  VARIABLE_NAME,
  type Declaration,
} from "./variables";

/** How a variable's values differ between environments, in one line. */
export function useValueSummary() {
  const t = useT();
  return (variable: VariableSummary) => {
    const values = Object.entries(variable.values);
    if (!Object.keys(variable.environments).length && "default" in variable)
      return fill(t("sameValueEverywhere"), {
        value: formatVariableValue(variable.default),
      });
    return values
      .map(([environment, value]) =>
        value.error
          ? `${environment} ${t("noVariableValue")}`
          : `${environment} ${formatVariableValue(value.value)}${value.source === "default" ? ` (${t("defaultValueSource")})` : ""}`,
      )
      .join(" · ");
  };
}

/** A parameter name turned into a free variable name. */
function suggestedName(parameter: string, taken: string[]) {
  const base =
    parameter
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^[^a-z]+/, "") || "variable";
  let name = base;
  for (let index = 2; taken.includes(name); index++) name = `${base}_${index}`;
  return name;
}

/**
 * The variable button of a parameter: compatible variables with their values,
 * incompatible ones with the reason, and the creation of a variable from the
 * current value.
 */
export function VariablePicker({
  snapshot,
  parameter,
  parameterType,
  variableType,
  value,
  disabled,
  onBind,
  onCreate,
}: {
  snapshot: Snapshot;
  parameter: string;
  parameterType: string;
  /** The type a variable created from the current value takes. */
  variableType: string;
  value: Json | undefined;
  disabled: boolean;
  onBind: (name: string) => void;
  onCreate: (name: string, declaration: Declaration) => Promise<void>;
}) {
  const t = useT();
  const summarize = useValueSummary();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const container = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const summary = snapshot.variables;
  const declared = Object.entries(summary?.declarations || {});
  const readable = !summary?.file_error && declarations(snapshot.bundle);
  const firstCompatible = declared.find(([, variable]) =>
    compatible(variable.type, parameterType),
  )?.[0];
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const label = fill(t("bindParameter"), { parameter });
  return (
    <span className="variable-picker-anchor" ref={container}>
      <button
        ref={trigger}
        type="button"
        className="variable-button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <Variable size={13} />
      </button>
      {open && (
        <div
          className="variable-picker"
          role="group"
          aria-label={label}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            setOpen(false);
            trigger.current?.focus();
          }}
        >
          <span className="eyebrow">
            {t("compatibleVariables")} · {parameterType}
          </span>
          {summary?.file_error && (
            <p className="variable-error">{summary.file_error}</p>
          )}
          {!declared.length && !summary?.file_error && (
            <p className="muted small">{t("noVariables")}</p>
          )}
          {declared.map(([name, variable]) => {
            const fits = compatible(variable.type, parameterType);
            return (
              <button
                type="button"
                key={name}
                className="variable-option"
                disabled={!fits}
                autoFocus={name === firstCompatible}
                onClick={() => {
                  setOpen(false);
                  onBind(name);
                }}
              >
                <code>{name}</code>
                <small>
                  {variable.type} ·{" "}
                  {fits ? summarize(variable) : t("incompatibleType")}
                </small>
              </button>
            );
          })}
          <hr />
          <button
            type="button"
            className="variable-option create"
            disabled={!readable}
            onClick={() => {
              setOpen(false);
              setCreating(true);
            }}
          >
            <Plus size={14} />
            <strong>
              {value === undefined || typeof value === "object"
                ? t("createVariable")
                : fill(t("createVariableFrom"), {
                    value: formatVariableValue(value),
                  })}
            </strong>
          </button>
          <p className="muted small">{t("variablePickerHint")}</p>
        </div>
      )}
      {creating &&
        // Outside the inspector, whose fieldset and layers would contain the dialog.
        createPortal(
          <CreateVariableDialog
            name={suggestedName(
              parameter,
              declared.map(([name]) => name),
            )}
            type={variableType}
            value={value}
            taken={declared.map(([name]) => name)}
            onCreate={onCreate}
            onClose={() => setCreating(false)}
          />,
          document.body,
        )}
    </span>
  );
}

/** Declare a variable holding the parameter's current value, then bind the parameter to it. */
function CreateVariableDialog({
  name: initialName,
  type,
  value: initialValue,
  taken,
  onCreate,
  onClose,
}: {
  name: string;
  type: string;
  value: Json | undefined;
  taken: string[];
  onCreate: (name: string, declaration: Declaration) => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [value, setValue] = useState(
    validValue(type, initialValue) ? initialValue : undefined,
  );
  const { pending, error, run } = useAsyncAction();
  const problem = !VARIABLE_NAME.test(name)
    ? t("invalidVariableName")
    : taken.includes(name)
      ? t("variableExists")
      : value !== undefined && !validValue(type, value)
        ? `${t("defaultValue")}: ${fill(t("invalidVariableValue"), { type })}`
        : "";
  return (
    <Modal title={t("newVariable")} onClose={onClose}>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (problem) return;
          const created = await run(() =>
            onCreate(name, {
              type,
              ...(description.trim()
                ? { description: description.trim() }
                : {}),
              ...(value === undefined ? {} : { default: value }),
            }),
          );
          if (created) onClose();
        }}
      >
        <div className="modal-content">
          <p className="muted">{t("createVariableHint")}</p>
          <label className="field">
            <span>{t("variableName")}</span>
            <input
              autoFocus
              className="code-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {looksSecret(name) && (
            <p className="notice warning">{t("secretVariableWarning")}</p>
          )}
          <label className="field">
            <span>{t("variableType")}</span>
            <input value={type} readOnly />
          </label>
          <label className="field">
            <span>{t("variableDescription")}</span>
            <textarea
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <div className="field">
            <span>
              <label htmlFor={id}>{t("defaultValue")}</label>
            </span>
            <VariableValueInput
              id={id}
              type={type}
              value={value}
              onChange={setValue}
            />
          </div>
          {(problem || error) && (
            <div className="notice error" role="alert">
              {problem || error}
            </div>
          )}
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="button primary" disabled={pending || !!problem}>
            {t(pending ? "saving" : "createAndBind")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

/** A parameter bound to a variable: its value in the active environment and how to unbind it. */
export function BoundVariable({
  snapshot,
  worktree,
  environment,
  parameter,
  parameterType,
  name,
  problem,
  disabled,
  onUnbind,
}: {
  snapshot: Snapshot;
  worktree: string;
  environment: string;
  parameter: string;
  parameterType: string;
  name: string;
  /** A diagnostic the engine reports on this binding. */
  problem?: string;
  disabled: boolean;
  onUnbind: () => void;
}) {
  const t = useT();
  const summarize = useValueSummary();
  const summary = snapshot.variables;
  const variable = variableSummary(snapshot, name);
  const current = variable?.values[environment];
  const error =
    summary?.file_error ||
    (!variable
      ? t("undeclaredVariable")
      : !compatible(variable.type, parameterType)
        ? t("incompatibleVariable")
        : current?.error) ||
    problem;
  return (
    <div
      className={`variable-binding ${error ? "has-error" : ""}`}
      role="group"
      aria-label={fill(t("boundParameter"), { parameter, name })}
    >
      <div className="variable-binding-value">
        <span className="variable-chip">
          <Variable size={12} />
          <code>{name}</code>
        </span>
        {!error && (
          <span className="grow">
            = {formatVariableValue(current?.value)}{" "}
            {fill(t("inEnvironment"), { environment })}
          </span>
        )}
        <button
          type="button"
          className="icon"
          disabled={disabled}
          aria-label={fill(t("unbindVariable"), { name })}
          title={fill(t("unbindVariable"), { name })}
          onClick={onUnbind}
        >
          <X size={14} />
        </button>
      </div>
      <div className="variable-binding-hint">
        {error ? (
          <span className="variable-error">{error}</span>
        ) : (
          <span>{summarize(variable!)}</span>
        )}
        <Link
          to={worktreeUrl(worktree, "variables", environment, {
            variable: name,
          })}
        >
          {t("openInVariables")}
          <ArrowRight size={13} />
        </Link>
      </div>
    </div>
  );
}
