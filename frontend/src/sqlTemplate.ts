/**
 * Read a Duckpad SQL template as the editor sees it, without Monaco: its
 * declarations, the names a line can reference, the problems the server would
 * refuse and what the text before the cursor expects next.
 *
 * The rules mirror `parse_template` and `validate_interface` in
 * `src/duckpad/templates.py`: an error reported here is always one there.
 */
import { RESERVED_KEYWORDS } from "./samples";

/** Python's `\w`, which matches any Unicode letter or digit. */
const WORD = String.raw`[\p{L}\p{N}_]`;
const DIRECTIVE = new RegExp(
  String.raw`^(\s*--\s*@)(${WORD}+)\s*(.*?)\s*$`,
  "u",
);
const PARAMETER = new RegExp(
  String.raw`^(${WORD}+)\s*:\s*([^=]+?)(?:\s*=\s*(.*))?$`,
  "u",
);
const REFERENCE = new RegExp(String.raw`\{\{\s*(${WORD}+)\s*\}\}`, "gu");
const IDENTIFIER = new RegExp(String.raw`^[A-Za-z_]${WORD}*$`, "u");

export const DIRECTIVES = [
  "label",
  "description",
  "input",
  "param",
  "output",
  "test",
  "message",
] as const;
export type DirectiveName = (typeof DIRECTIVES)[number];

/**
 * Parameter types, with what their argument names: a connection parameter, a
 * declared input, a schema_name parameter, options or a list item type.
 */
export const PARAMETER_TYPES = {
  text: null,
  number: null,
  boolean: null,
  date: null,
  choice: "options",
  keyword: "options",
  file: "connection",
  destination: "connection",
  connection: null,
  secret: "connection",
  column: "input",
  identifier: null,
  schema_name: "connection",
  table_name: "schema",
  expression: "input",
  expressions: null,
  schema: null,
  list: "item",
  column_selection: "input",
  value_cleaning: "input",
} as const;
export type ParameterType = keyof typeof PARAMETER_TYPES;
/** Whether a name is a parameter type, not an inherited object key such as `constructor`. */
export const isParameterType = (name: string): name is ParameterType =>
  Object.hasOwn(PARAMETER_TYPES, name);
export const LIST_ITEM_TYPES = ["text", "number", "boolean", "column"];
const CONNECTION_BOUND = new Set([
  "file",
  "destination",
  "secret",
  "schema_name",
]);

/** `file(connection)` -> `file`, as Python's `base_type`. */
const baseType = (type: string) => type.trim().split(/[<(]/)[0];
/** `choice(a|b)` -> `a|b`, as Python's `type_argument`. */
const typeArgument = (type: string) => /\((.*)\)/.exec(type)?.[1] || null;

export type DeclarationKind = "input" | "parameter" | "output";
export interface Declaration {
  kind: DeclarationKind;
  name: string;
  /** 1-based line and columns of the name. */
  line: number;
  column: number;
  /** Parameters only. */
  type?: string;
  default?: string;
}
export interface TemplateBlock {
  /** The directive that opens it; null for statements before any of them. */
  kind: "output" | "test" | "message" | null;
  name: string | null;
  /** The line of its directive, or 1. */
  line: number;
  /** The last line before the next block. */
  end: number;
}
export interface TemplateOutline {
  declarations: Declaration[];
  blocks: TemplateBlock[];
  label?: string;
  description?: string;
}

interface DirectiveLine {
  key: string;
  value: string;
  /** 1-based column of the key and of the value. */
  keyColumn: number;
  valueColumn: number;
}

/** `-- @param limit: number` on a line, or null for SQL. */
export function readDirective(line: string): DirectiveLine | null {
  const match = DIRECTIVE.exec(line);
  if (!match) return null;
  const [, lead, key, value] = match;
  const rest = line.slice(lead.length + key.length);
  return {
    key,
    value,
    keyColumn: lead.length + 1,
    valueColumn: lead.length + key.length + rest.search(/\S|$/) + 1,
  };
}

export function outlineTemplate(text: string): TemplateOutline {
  const outline: TemplateOutline = { declarations: [], blocks: [] };
  const lines = text.split(/\r?\n/);
  let block: TemplateBlock = { kind: null, name: null, line: 1, end: 1 };
  lines.forEach((line, index) => {
    const number = index + 1;
    const found = readDirective(line);
    if (!found) return;
    const { key, value, valueColumn } = found;
    if (key === "label" || key === "description") outline[key] = value;
    else if (key === "input" || key === "output")
      outline.declarations.push({
        kind: key,
        name: value,
        line: number,
        column: valueColumn,
      });
    else if (key === "param") {
      const parameter = PARAMETER.exec(value);
      if (parameter)
        outline.declarations.push({
          kind: "parameter",
          name: parameter[1],
          line: number,
          column: valueColumn,
          type: parameter[2].trim(),
          default: parameter[3],
        });
    }
    if (key === "output" || key === "test" || key === "message") {
      block.end = number - 1;
      outline.blocks.push(block);
      block = {
        kind: key,
        name: key === "message" ? null : value.split(":")[0].trim(),
        line: number,
        end: number,
      };
    }
  });
  block.end = lines.length;
  outline.blocks.push(block);
  return outline;
}

/** The block holding a line. */
export const blockAt = (outline: TemplateOutline, line: number) =>
  outline.blocks.find((block) => line >= block.line && line <= block.end) ??
  outline.blocks[outline.blocks.length - 1];

/**
 * The names a reference on this line can use: inputs and parameters, then
 * outputs computed before its block. Checks and writes run after every output.
 */
export function referencesAt(
  outline: TemplateOutline,
  line: number,
): Declaration[] {
  const block = blockAt(outline, line);
  const available = outline.declarations.filter((d) => d.kind !== "output");
  const outputs = outline.declarations.filter((d) => d.kind === "output");
  if (block.kind !== "output") return [...available, ...outputs];
  const earlier = outline.blocks
    .filter((b) => b.kind === "output" && b.line < block.line)
    .map((b) => b.name);
  return [...available, ...outputs.filter((d) => earlier.includes(d.name))];
}

export type TemplateProblemCode =
  | "unknownDirective"
  | "invalidParameter"
  | "unknownParameterType"
  | "invalidName"
  | "duplicateName"
  | "parameterArgument"
  | "undeclaredReference"
  | "invalidTestName"
  | "duplicateTestName"
  | "invalidTestSeverity"
  | "messageArguments"
  | "emptyCheck"
  | "quotedReference";
export interface TemplateProblem {
  code: TemplateProblemCode;
  /** The name, type or directive the message is about. */
  subject: string;
  severity: "error" | "warning";
  line: number;
  column: number;
  endColumn: number;
}

/**
 * Line breaks or spaces for Python but not for the browser, or the reverse
 * (the byte order mark): with them, lines and names could differ from the
 * server's reading, so the checks stay silent.
 */
const AMBIGUOUS = /[\v\f\x85\u2028\u2029\ufeff]/;
const ambiguous = (text: string) =>
  AMBIGUOUS.test(text) ||
  // The file, group, record and unit separators.
  [...text].some((char) => char >= "\u001c" && char <= "\u001f");

/** The problems of a SQL template that the server reports on save. */
export function lintTemplate(text: string): TemplateProblem[] {
  if (ambiguous(text)) return [];
  const problems: TemplateProblem[] = [];
  const lines = text.split(/\r?\n/);
  const at = (
    code: TemplateProblemCode,
    subject: string,
    line: number,
    column: number,
    length = subject.length,
    severity: TemplateProblem["severity"] = "error",
  ) =>
    problems.push({
      code,
      subject,
      severity,
      line,
      column,
      endColumn: column + Math.max(length, 1),
    });
  const tests = new Set<string>();
  // Checks need a query before the next block.
  let check: { line: number; column: number; key: string } | null = null;
  let checkHasQuery = false;
  const closeCheck = () => {
    if (check && !checkHasQuery)
      at("emptyCheck", check.key, check.line, check.column, check.key.length);
    check = null;
  };
  lines.forEach((line, index) => {
    const number = index + 1;
    const found = readDirective(line);
    if (!found) {
      if (line.trim()) checkHasQuery = true;
      return;
    }
    const { key, value, keyColumn, valueColumn } = found;
    if (!(DIRECTIVES as readonly string[]).includes(key))
      return at("unknownDirective", key, number, keyColumn);
    if (key === "param") {
      const parameter = PARAMETER.exec(value);
      if (!parameter)
        return at("invalidParameter", value, number, valueColumn, value.length);
      const type = parameter[2];
      if (!isParameterType(baseType(type))) {
        const column = valueColumn + value.indexOf(type, parameter[1].length);
        at("unknownParameterType", type.trim(), number, column, type.length);
      }
    }
    if (key === "output" || key === "test" || key === "message") {
      closeCheck();
      checkHasQuery = false;
    }
    if (key === "message") {
      if (value)
        at("messageArguments", value, number, valueColumn, value.length);
      check = { line: number, column: keyColumn, key };
    } else if (key === "test") {
      const [rawName, ...rest] = value.split(":");
      const name = rawName.trim();
      const severity = rest.length ? rest.join(":").trim() : "error";
      if (!IDENTIFIER.test(name))
        at("invalidTestName", name, number, valueColumn, rawName.length);
      else if (tests.has(name))
        at("duplicateTestName", name, number, valueColumn, name.length);
      tests.add(name);
      if (severity !== "warning" && severity !== "error")
        at(
          "invalidTestSeverity",
          severity,
          number,
          valueColumn + value.lastIndexOf(severity),
          severity.length,
        );
      check = { line: number, column: keyColumn, key };
    }
  });
  closeCheck();

  const outline = outlineTemplate(text);
  const seen = new Map<string, number>();
  for (const declaration of outline.declarations) {
    seen.set(declaration.name, (seen.get(declaration.name) ?? 0) + 1);
    if (!IDENTIFIER.test(declaration.name))
      at("invalidName", declaration.name, declaration.line, declaration.column);
  }
  for (const declaration of outline.declarations)
    if ((seen.get(declaration.name) ?? 0) > 1)
      at(
        "duplicateName",
        declaration.name,
        declaration.line,
        declaration.column,
      );
  const parameters = new Map(
    outline.declarations
      .filter((d) => d.kind === "parameter")
      .map((d) => [d.name, d]),
  );
  const inputs = outline.declarations
    .filter((d) => d.kind === "input")
    .map((d) => d.name);
  for (const parameter of parameters.values()) {
    const type = parameter.type!;
    const kind = baseType(type);
    const argument = typeArgument(type);
    const valid =
      kind === "column_selection" || kind === "value_cleaning"
        ? argument !== null && inputs.includes(argument)
        : kind === "table_name"
          ? argument !== null &&
            baseType(parameters.get(argument)?.type ?? "") === "schema_name"
          : kind === "schema_name" && argument === null
            ? false
            : !CONNECTION_BOUND.has(kind) ||
                (argument === null && kind !== "secret")
              ? true
              : argument !== null &&
                parameters.get(argument)?.type === "connection";
    if (!valid)
      at("parameterArgument", parameter.name, parameter.line, parameter.column);
  }

  // References, checked against what each block can read.
  lines.forEach((line, index) => {
    const number = index + 1;
    if (readDirective(line)) return;
    const allowed = new Set(referencesAt(outline, number).map((d) => d.name));
    for (const match of line.matchAll(REFERENCE)) {
      const column = match.index + 1;
      if (!allowed.has(match[1]))
        at("undeclaredReference", match[1], number, column, match[0].length);
      else if (
        line[match.index - 1] === "'" &&
        line[match.index + match[0].length] === "'"
      )
        at(
          "quotedReference",
          match[1],
          number,
          column - 1,
          match[0].length + 2,
          "warning",
        );
    }
  });
  return problems.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** What the text before the cursor, on its line, is about to complete. */
export type SqlCursor =
  | { kind: "directive"; prefix: string }
  | { kind: "parameterType"; prefix: string }
  | {
      kind: "typeArgument";
      type: ParameterType;
      prefix: string;
    }
  | { kind: "parameterDefault"; type: string; prefix: string; quoted: boolean }
  | { kind: "testSeverity"; prefix: string }
  | { kind: "declaration" }
  | { kind: "reference"; prefix: string; spaced: boolean }
  | { kind: "member"; owner: string; prefix: string }
  | { kind: "comment" }
  | { kind: "string" }
  | { kind: "cast"; prefix: string }
  | { kind: "sql"; prefix: string };

export function sqlCursor(before: string): SqlCursor {
  const directive = /^\s*--\s*@(\p{L}*)$/u.exec(before);
  if (directive) return { kind: "directive", prefix: directive[1] };
  // The text after the directive keeps its trailing spaces, unlike readDirective.
  const directiveLine = /^\s*--\s*@(\w+)(?:\s+(.*))?$/.exec(before);
  if (directiveLine) {
    const [, key, value = ""] = directiveLine;
    if (key === "param") {
      const declared = /^\w+\s*:\s*([^=]*)$/.exec(value);
      if (declared) {
        const argument = /^(\w+)\s*[(<]\s*([^)>|]*)$/.exec(declared[1]);
        if (argument && isParameterType(argument[1]))
          return {
            kind: "typeArgument",
            type: argument[1],
            prefix: argument[2],
          };
        if (/^\w*$/.test(declared[1]))
          return { kind: "parameterType", prefix: declared[1] };
        return { kind: "declaration" };
      }
      const valued = /^\w+\s*:\s*([^=]+?)\s*=\s*("?)((?:\\.|[^"\\])*)$/.exec(
        value,
      );
      if (valued)
        return {
          kind: "parameterDefault",
          type: valued[1].trim(),
          quoted: valued[2] === '"',
          prefix: valued[3],
        };
      return { kind: "declaration" };
    }
    if (key === "test") {
      const severity = /^\w+\s*:\s*(\w*)$/.exec(value);
      return severity
        ? { kind: "testSeverity", prefix: severity[1] }
        : { kind: "declaration" };
    }
    return { kind: "declaration" };
  }
  // Text after a line comment, or inside a string, completes nothing.
  let quote: string | null = null;
  for (let index = 0; index < before.length; index++) {
    const char = before[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "-" && before[index + 1] === "-")
      return { kind: "comment" };
  }
  if (quote === "'") return { kind: "string" };
  const reference = /{{(\s*)(\w*)$/.exec(before);
  if (reference)
    return { kind: "reference", prefix: reference[2], spaced: !!reference[1] };
  const member = /(?:{{\s*(\w+)\s*}}|("?)(\w+)\2)\.(\w*)$/.exec(before);
  if (member)
    return { kind: "member", owner: member[1] ?? member[3], prefix: member[4] };
  const cast = /::\s*(\w*)$/.exec(before);
  if (cast) return { kind: "cast", prefix: cast[1] };
  return { kind: "sql", prefix: /\w*$/.exec(before)![0] };
}

/**
 * The inputs that names refer to in a block: `{{ orders }} o` or
 * `{{ orders }} AS o` makes `o` an alias of `orders`.
 */
export function inputAliases(block: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const match of block.matchAll(
    /{{\s*(\w+)\s*}}(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi,
  )) {
    aliases.set(match[1], match[1]);
    if (match[2] && !RESERVED_KEYWORDS.has(match[2].toLowerCase()))
      aliases.set(match[2], match[1]);
  }
  return aliases;
}

/** The function call around the cursor, with the index of its current argument. */
export function enclosingCall(
  before: string,
): { name: string; argument: number; named: string[] } | null {
  let depth = 0;
  let commas = 0;
  let quote: string | null = null;
  const named: string[] = [];
  for (let index = before.length - 1; index >= 0; index--) {
    const char = before[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === ")" || char === "]") depth++;
    else if (char === "(" || char === "[") {
      if (depth === 0) {
        if (char === "[") return null;
        const name = /(\w+)\s*$/.exec(before.slice(0, index));
        if (!name) return null;
        // Named options already given: `header = true`.
        const args = before.slice(index + 1);
        for (const option of args.matchAll(/(?:^|,)\s*(\w+)\s*:?=/g))
          named.push(option[1]);
        return { name: name[1].toLowerCase(), argument: commas, named };
      }
      depth--;
    } else if (char === "," && depth === 0) commas++;
    else if (char === ";") return null;
  }
  return null;
}
