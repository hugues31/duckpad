import type { Translate } from "./i18n";
import type {
  Bundle,
  Json,
  Snapshot,
  VariableSummary,
  VariableValue,
} from "./types";

/** The file that declares the project variables of a branch. */
export const VARIABLES_FILE = "variables.json";
/** Variable names: lowercase letters, digits and underscores, starting with a letter. */
export const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
/** The types a variable can declare; `choice` takes its options in parentheses. */
export const VARIABLE_TYPES = [
  "text",
  "number",
  "boolean",
  "date",
  "choice",
  "identifier",
  "list<text>",
  "list<number>",
] as const;
const SECRET_HINTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "credential",
  "private_key",
];
// Parameter types each variable type binds to, as the engine checks them.
const BINDABLE: Record<string, string[]> = {
  text: ["text", "file", "destination"],
  number: ["number"],
  boolean: ["boolean"],
  date: ["date"],
  identifier: ["identifier", "column"],
  choice: ["text"],
};

/** A declaration as stored in variables.json. */
export type Declaration = {
  type: string;
  description?: string;
  default?: Json;
  environments?: Record<string, Json>;
};

/** `choice(a|b)` -> `choice`, `list<text>` -> `list`. */
export const baseType = (type: string) => type.trim().split(/[<(]/)[0].trim();

/** The options of `choice(a|b)` or `keyword(a|b)`. */
export function typeOptions(type: string): string[] {
  const argument = type.match(/\((.*)\)/)?.[1];
  return argument ? argument.split("|").map((option) => option.trim()) : [];
}

/** The variable named by a parameter value such as `{"$var": "order_status"}`. */
export function variableReference(value: unknown): string | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  )
    return null;
  const name = (value as Record<string, unknown>).$var;
  return typeof name === "string" ? name : null;
}

export const bindTo = (name: string) => ({ $var: name });

/** Whether a variable type can be bound to a parameter type. */
export function compatible(variableType: string, parameterType: string) {
  const kind = baseType(variableType);
  const target = baseType(parameterType);
  if (kind === "list")
    return parameterType.replace(/\s+/g, "") === variableType;
  if (BINDABLE[kind]?.includes(target)) return true;
  if (kind === "choice" && (target === "choice" || target === "keyword")) {
    const offered = typeOptions(parameterType);
    return (
      (target === "choice" && !offered.length) ||
      typeOptions(variableType).every((option) => offered.includes(option))
    );
  }
  return false;
}

/** The variable type that holds a parameter's value, or null when the parameter cannot be bound. */
export function variableTypeFor(parameterType: string): string | null {
  const type = parameterType.trim();
  const target = baseType(type);
  if (["text", "file", "destination"].includes(target)) return "text";
  if (["number", "boolean", "date"].includes(target)) return target;
  if (["identifier", "column"].includes(target)) return "identifier";
  const list = type.replace(/\s+/g, "");
  if (list === "list<text>" || list === "list<number>") return list;
  if ((target === "choice" || target === "keyword") && typeOptions(type).length)
    return `choice(${typeOptions(type).join("|")})`;
  return null;
}

const isDate = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().startsWith(value);

/** Whether a value matches a variable type. */
export function validValue(type: string, value: unknown): boolean {
  const kind = baseType(type);
  if (kind === "text") return typeof value === "string";
  if (kind === "identifier")
    return typeof value === "string" && value.trim() !== "";
  if (kind === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (kind === "boolean") return typeof value === "boolean";
  if (kind === "date") return isDate(value);
  if (kind === "choice")
    return typeof value === "string" && typeOptions(type).includes(value);
  const item = type === "list<text>" ? "text" : "number";
  return Array.isArray(value) && value.every((x) => validValue(item, x));
}

/** A starting value of a type, for an environment that stops using the default. */
export function initialValue(type: string): Json | undefined {
  const kind = baseType(type);
  if (kind === "number") return 0;
  if (kind === "boolean") return false;
  if (kind === "date") return new Date().toISOString().slice(0, 10);
  if (kind === "choice") return typeOptions(type)[0];
  if (kind === "list") return [];
  return "";
}

/** A value as the interface shows it. */
export function formatVariableValue(value: unknown): string {
  if (value === undefined) return "—";
  if (Array.isArray(value)) return value.map(formatVariableValue).join(", ");
  return typeof value === "string" ? value : JSON.stringify(value);
}

export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

/** A declaration's value in an environment: its value there, otherwise its default. */
export function resolveValue(
  declaration: Declaration | undefined,
  environment: string,
): VariableValue {
  if (!declaration) return {};
  if (declaration.environments && environment in declaration.environments)
    return {
      value: declaration.environments[environment],
      source: "environment",
    };
  return "default" in declaration
    ? { value: declaration.default, source: "default" }
    : {};
}

/** Whether a name looks like a credential, which belongs to a connection instead. */
export const looksSecret = (name: string) =>
  SECRET_HINTS.some((hint) => name.includes(hint));

/** The declarations of a bundle, or null when variables.json cannot be read. */
export function declarations(
  bundle: Bundle | null,
): Record<string, Declaration> | null {
  const value = bundle?.variables;
  if (value === undefined || value === null) return {};
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Declaration>)
    : null;
}

/** The summary of a declared variable, if the snapshot has one. */
export const variableSummary = (
  snapshot: Snapshot,
  name: string,
): VariableSummary | undefined => {
  const declared = snapshot.variables?.declarations;
  return declared && Object.hasOwn(declared, name) ? declared[name] : undefined;
};

/** Root flow nodes downstream of the given ones, excluding them. */
export function descendants(bundle: Bundle, nodes: string[]) {
  const found = new Set<string>();
  const queue = [...nodes];
  while (queue.length) {
    const node = queue.shift()!;
    for (const edge of bundle.flow.edges)
      if (
        edge.source === node &&
        !nodes.includes(edge.target) &&
        !found.has(edge.target)
      ) {
        found.add(edge.target);
        queue.push(edge.target);
      }
  }
  return found;
}

/** The environments in which a declaration change gives a different value. */
export const changedEnvironments = (
  before: Declaration | undefined,
  after: Declaration,
  environments: string[],
) =>
  environments.filter(
    (environment) =>
      !sameValue(
        resolveValue(before, environment).value,
        resolveValue(after, environment).value,
      ),
  );

/** Replace `{name}` placeholders of a translated text. */
export const fill = (text: string, values: Record<string, string | number>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );

/** A merge path inside variables.json, named after its variable and field, else null. */
export function conflictLabel(path: string, t: Translate) {
  const prefix = VARIABLES_FILE + "/";
  if (!path.startsWith(prefix)) return null;
  const [name, field, environment] = path
    .slice(prefix.length)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const detail =
    field === "environments" && environment
      ? fill(t("environmentValue"), { environment })
      : field === "default"
        ? t("defaultValue")
        : field === "description"
          ? t("variableDescription")
          : field === "type"
            ? t("variableType")
            : field;
  return `${t("variable")} ${name}${detail ? ` · ${detail}` : ""}`;
}
