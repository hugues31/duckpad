import { useId, useRef, useState } from "react";
import { useT } from "./i18n";
import type { VariablesSummary } from "./types";
import {
  completeReference,
  fill,
  formatVariableValue,
  computedDiagnostic,
  partialReference,
  referencedVariables,
  usableInExpressions,
} from "./variables";

/** The variables an expression field can reference, and the environment to highlight. */
export type ExpressionVariables = {
  summary: VariablesSummary | null;
  environment: string;
};

/**
 * An expression parameter's text area. Typing `{{ var.` suggests the variables
 * an expression can use; arrow keys choose one, Enter or Tab inserts it.
 */
export function ExpressionInput({
  id,
  value,
  variables,
  onChange,
  onBlur,
  singleLine,
}: {
  id: string;
  value: string;
  variables: ExpressionVariables;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** A path: one line, where Enter only accepts a suggestion. */
  singleLine?: boolean;
}) {
  const t = useT();
  const list = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const { summary, environment } = variables;
  const options =
    prefix === null
      ? []
      : Object.entries(summary?.declarations || {}).filter(
          ([name, variable]) =>
            name.startsWith(prefix) && usableInExpressions(variable.type),
        );
  const open = prefix !== null && (options.length > 0 || !!summary);
  const track = (element: HTMLTextAreaElement) => {
    const caret = element.selectionStart;
    const partial =
      caret === element.selectionEnd
        ? partialReference(element.value.slice(0, caret))
        : null;
    setPrefix(partial ? partial.prefix : null);
    setActive(0);
  };
  const insert = (name: string) => {
    const element = input.current;
    if (!element) return;
    const completed = completeReference(
      element.value,
      element.selectionStart,
      name,
    );
    setPrefix(null);
    if (!completed) return;
    onChange(completed.text);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(completed.caret, completed.caret);
    });
  };
  const optionId = (name: string) => `${list}-${name}`;
  return (
    <div className="expression-input">
      <textarea
        ref={input}
        id={id}
        rows={singleLine ? 1 : 3}
        className="code-input"
        value={value}
        aria-autocomplete="list"
        aria-controls={open ? list : undefined}
        aria-activedescendant={
          open && options[active] ? optionId(options[active][0]) : undefined
        }
        onChange={(e) => {
          onChange(e.target.value);
          track(e.target);
        }}
        onSelect={(e) => track(e.currentTarget)}
        onKeyDown={(e) => {
          if (singleLine && e.key === "Enter" && !(open && options[active]))
            e.preventDefault();
          if (!open) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            setPrefix(null);
          } else if (options.length && e.key === "ArrowDown") {
            e.preventDefault();
            setActive((active + 1) % options.length);
          } else if (options.length && e.key === "ArrowUp") {
            e.preventDefault();
            setActive((active + options.length - 1) % options.length);
          } else if (
            options[active] &&
            (e.key === "Enter" || e.key === "Tab")
          ) {
            e.preventDefault();
            insert(options[active][0]);
          }
        }}
        onBlur={() => {
          setPrefix(null);
          onBlur?.();
        }}
      />
      {open && (
        <div
          className="variable-picker expression-suggestions"
          id={list}
          role="listbox"
          aria-label={t("variableSuggestions")}
        >
          <span className="eyebrow">{t("variableSuggestions")}</span>
          {summary?.file_error && (
            <p className="variable-error">{summary.file_error}</p>
          )}
          {!options.length && !summary?.file_error && (
            <p className="muted small">{t("noExpressionVariables")}</p>
          )}
          {options.map(([name, variable], index) => (
            <div
              key={name}
              id={optionId(name)}
              role="option"
              aria-selected={index === active}
              className={`variable-option ${index === active ? "active" : ""}`}
              // Keep the focus, and the caret, in the text area.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(name)}
            >
              <code>{name}</code>
              <small>
                {variable.type} ·{" "}
                {variable.values[environment]?.error
                  ? computedDiagnostic(variable.values[environment]?.code, t) ||
                    t("noVariableValue")
                  : `${environment} ${formatVariableValue(variable.values[environment]?.value)}`}
                {variable.from && (
                  <span>
                    {" "}
                    ·{" "}
                    {[
                      variable.from.node,
                      variable.from.port,
                      variable.from.column,
                    ]
                      .filter(Boolean)
                      .join(".")}
                  </span>
                )}
              </small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The value of each variable an expression references, in every environment. */
export function ExpressionValues({
  value,
  variables,
}: {
  value: string;
  variables: ExpressionVariables;
}) {
  const t = useT();
  const { summary, environment } = variables;
  const names = referencedVariables(value);
  if (!names.length) return null;
  return (
    <ul className="expression-values" aria-label={t("referencedVariables")}>
      {names.map((name) => {
        const variable = summary?.declarations[name];
        return (
          <li key={name}>
            <code>{name}</code>
            {summary?.file_error ? (
              <span className="variable-error">{summary.file_error}</span>
            ) : !variable ? (
              <span className="variable-error">{t("undeclaredVariable")}</span>
            ) : !usableInExpressions(variable.type) ? (
              <span className="variable-error">
                {fill(t("variableNotInExpressions"), { type: variable.type })}
              </span>
            ) : (
              Object.entries(variable.values).map(([shown, resolved]) => (
                <span
                  key={shown}
                  className={shown === environment ? "active" : undefined}
                >
                  {shown}{" "}
                  <strong>
                    {resolved.error
                      ? computedDiagnostic(resolved.code, t) ||
                        t("noVariableValue")
                      : formatVariableValue(resolved.value)}
                  </strong>
                  {resolved.source === "default" && (
                    <small> ({t("defaultValueSource")})</small>
                  )}
                  {resolved.source === "node" && resolved.from && (
                    <small>
                      {" "}
                      (
                      {[
                        resolved.from.node,
                        resolved.from.port,
                        resolved.from.column,
                      ]
                        .filter(Boolean)
                        .join(".")}
                      )
                    </small>
                  )}
                </span>
              ))
            )}
          </li>
        );
      })}
    </ul>
  );
}
