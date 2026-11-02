import { Link, useParams } from "react-router";
import { withQuery } from "./api";
import { useT } from "./i18n";
import ParameterInput from "./ParameterInput";
import Select from "./Select";
import type {
  Json,
  PreviewPage,
  Run,
  Snapshot,
  Statement,
  VariableValue,
} from "./types";
import { useApiResource } from "./useApiResource";
import {
  baseType,
  computedDiagnostic,
  descendants,
  fill,
  formatVariableValue,
  sameValue,
  typeOptions,
  variableSummary,
} from "./variables";

/** Edit a value of a variable type; an empty field gives `undefined`. */
export function VariableValueInput({
  type,
  value,
  onChange,
  id,
  label,
  placeholder,
  disabled = false,
}: {
  type: string;
  value: Json | undefined;
  onChange: (value: Json | undefined) => void;
  id?: string;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const kind = baseType(type);
  const common = { id, disabled, "aria-label": label };
  if (kind === "boolean" || kind === "choice") {
    const options = kind === "boolean" ? ["true", "false"] : typeOptions(type);
    const current = value === undefined ? "" : String(value);
    return (
      <Select
        {...common}
        value={current}
        onChange={(e) =>
          onChange(
            e.target.value === ""
              ? undefined
              : kind === "boolean"
                ? e.target.value === "true"
                : e.target.value,
          )
        }
      >
        {(value === undefined || !options.includes(current)) && (
          <option value={current}>{placeholder || current}</option>
        )}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  }
  if (kind === "number" || kind === "list")
    return (
      <ParameterInput
        key={type}
        id={id}
        label={label}
        placeholder={placeholder}
        disabled={disabled}
        kind={kind}
        commitOnChange
        value={value}
        onChange={(next) => {
          if (kind === "number" || !Array.isArray(next)) return onChange(next);
          const items = next.filter((item) => item !== "");
          // Keep text that is not a number, so validation can point at it.
          onChange(
            type === "list<number>"
              ? items.map((item) =>
                  typeof item === "string" && Number.isFinite(Number(item))
                    ? Number(item)
                    : item,
                )
              : items,
          );
        }}
      />
    );
  return (
    <input
      {...common}
      type={kind === "date" ? "date" : "text"}
      placeholder={placeholder}
      value={typeof value === "string" ? value : ""}
      onChange={(e) =>
        onChange(
          kind === "text" || e.target.value !== "" ? e.target.value : undefined,
        )
      }
    />
  );
}

/** Where a resolved value comes from: the default, or the environment's own value. */
export function useSourceLabel() {
  const t = useT();
  return (source: string | undefined, environment: string) =>
    source === "environment"
      ? fill(t("environmentValue"), { environment })
      : source === "default"
        ? t("defaultValueSource")
        : "";
}

/**
 * Variables with their resolved values, as a launch, a run record or compiled
 * statements report them: name -> type, and value and source, or error.
 */
export function VariableValues({
  variables,
  environment,
  parameters,
}: {
  variables: Record<string, VariableValue>;
  environment: string;
  /** The parameters bound to each variable, when they are known. */
  parameters?: Record<string, string[]>;
}) {
  const source = useSourceLabel();
  const t = useT();
  return (
    <table className="variable-values">
      <tbody>
        {Object.entries(variables).map(([name, item]) => (
          <tr key={name}>
            <th scope="row">
              <code>{name}</code>
              {!!parameters?.[name]?.length && (
                <small>{parameters[name].join(", ")}</small>
              )}
            </th>
            {item.error ? (
              <td className="variable-error" colSpan={2}>
                {item.code && (
                  <strong>{computedDiagnostic(item.code, t)}</strong>
                )}
                {item.error}
              </td>
            ) : (
              <>
                <td>
                  <strong>
                    {item.state === "pending"
                      ? t("calculatedAtLaunch")
                      : formatVariableValue(item.value)}
                  </strong>
                </td>
                <td className="muted">
                  {item.source === "node" ? (
                    <>
                      <span>
                        {item.resolution === "retained"
                          ? t("retainedValue")
                          : t("computedFromNode")}
                      </span>
                      <small>
                        {item.from &&
                          [item.from.node, item.from.port, item.from.column]
                            .filter(Boolean)
                            .join(".")}
                      </small>
                      {item.producer_run && (
                        <small>
                          {item.producer_run} ·{" "}
                          {item.producer_commit?.slice(0, 8)}
                        </small>
                      )}
                      <ValueSourceLink value={item} environment={environment} />
                    </>
                  ) : (
                    source(item.source, environment)
                  )}
                </td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Open only the recorded generation, never today's replacement source result. */
function ValueSourceLink({
  value,
  environment,
}: {
  value: VariableValue;
  environment: string;
}) {
  const t = useT();
  const { worktreeId } = useParams();
  const { data } = useApiResource<{ valid: boolean }>(
    worktreeId && value.source_dataset
      ? withQuery(
          `/worktrees/${worktreeId}/generations/${value.source_dataset}`,
          { environment },
        )
      : null,
  );
  if (!data?.valid || !value.from) return null;
  return (
    <small>
      <Link
        to={withQuery(`/worktrees/${worktreeId}/flow`, {
          environment,
          node: value.from.node,
        })}
        state={{
          valueSource: {
            dataset: value.source_dataset,
            row: 0,
            column: value.from.column,
          },
        }}
      >
        {t("openValueSource")}
      </Link>
    </small>
  );
}

/** The variables bound in compiled or executed statements, next to their values. */
export function StatementVariables({
  statements,
  environment,
}: {
  statements: Statement[];
  environment: string;
}) {
  const t = useT();
  const variables: Record<string, VariableValue> = Object.create(null);
  const parameters: Record<string, string[]> = Object.create(null);
  for (const statement of statements)
    for (const item of statement.variables || []) {
      variables[item.name] = item;
      const bound = (parameters[item.name] ||= []);
      // A reference inside an expression shows the SQL parameter holding its value.
      const usage = item.binding
        ? `${item.parameter} · $${item.binding}`
        : item.parameter;
      if (!bound.includes(usage)) bound.push(usage);
    }
  if (!Object.keys(variables).length) return null;
  return (
    <>
      <h4>{t("variables")}</h4>
      <VariableValues
        variables={variables}
        environment={environment}
        parameters={parameters}
      />
    </>
  );
}

/**
 * Why a stale result no longer matches its variables: the variables that the
 * node or its ancestors use, whose value in this environment differs from the
 * one recorded by the run that produced it.
 */
export function useStaleVariables(
  snapshot: Snapshot,
  environment: string,
  result: PreviewPage | null,
) {
  const t = useT();
  const stale = result?.status === "stale" && result.run;
  const run = useApiResource<Run>(stale ? `/runs/${result.run}` : null);
  const bundle = snapshot.bundle;
  const summary = snapshot.variables;
  if (!stale || !run.data?.variables || !bundle || !summary) return [];
  const root = String(result.node).split("::")[0];
  return Object.entries(run.data.variables).flatMap(([name, used]) => {
    const declared = variableSummary(snapshot, name);
    const current = declared?.values[environment];
    const usages = (declared?.usages || []).map((usage) => usage.node);
    if (
      !declared ||
      !(usages.includes(root) || descendants(bundle, usages).has(root)) ||
      (sameValue(current?.value, used.value) && !current?.error)
    )
      return [];
    return [
      fill(t("staleVariable"), {
        name,
        environment,
        before: formatVariableValue(used.value),
        after: current?.error
          ? t("noVariableValue")
          : formatVariableValue(current?.value),
      }),
    ];
  });
}

/** The variables a launch would use, with their values, before it is confirmed. */
export function ScopeVariables({
  worktree,
  environment,
  node,
}: {
  worktree: string;
  environment: string;
  node?: string;
}) {
  const t = useT();
  const scope = useApiResource<Record<string, VariableValue>>(
    withQuery(`/worktrees/${worktree}/variables/scope`, { environment, node }),
  );
  if (scope.error)
    return (
      <p className="notice error" role="alert">
        {scope.error}
      </p>
    );
  if (!scope.data || !Object.keys(scope.data).length) return null;
  return (
    <section className="scope-variables">
      <h4 className="eyebrow">
        {fill(t("variablesUsedByRun"), { environment })}
      </h4>
      <VariableValues variables={scope.data} environment={environment} />
      <p className="muted small">{t("variablesRecordedHint")}</p>
    </section>
  );
}
