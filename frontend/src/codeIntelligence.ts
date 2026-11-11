/**
 * Duckpad's language support in Monaco: highlighting, completion, hovers,
 * signature help and checks for node SQL and Python, and variable references
 * in flow.json. Each editor registers what its code can reference with
 * `setCodeContext`; the providers read it from the model they are asked about.
 */
import "./monacoFeatures";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import {
  loadCodeCatalog,
  type CodeCatalog,
  type PythonMember,
  type SqlFunction,
} from "./codeCatalog";
import type { CodeContext, CodeInput } from "./codeEditing";
import type { Translate, TranslationKey } from "./i18n";
import { outlinePython, pythonCursor, stringPurpose } from "./pythonNode";
import { quoteIdentifier, RESERVED_KEYWORDS } from "./samples";
import {
  blockAt,
  DIRECTIVES,
  enclosingCall,
  inputAliases,
  LIST_ITEM_TYPES,
  lintTemplate,
  outlineTemplate,
  PARAMETER_TYPES,
  readDirective,
  referencesAt,
  sqlCursor,
  type Declaration,
  type DirectiveName,
  type ParameterType,
  type TemplateOutline,
  type TemplateProblem,
} from "./sqlTemplate";

type Context = CodeContext & { t: Translate };
type Model = monaco.editor.ITextModel;
type Position = monaco.Position;
type Item = monaco.languages.CompletionItem;
type Markdown = monaco.IMarkdownString;

const contexts = new WeakMap<Model, Context>();

/** Tell the providers what the code of a model can reference. */
export function setCodeContext(model: Model, context: Context) {
  contexts.set(model, context);
}

const { CompletionItemKind: Kind, CompletionItemInsertTextRule: Rule } =
  monaco.languages;

let catalog: CodeCatalog | null = null;
let functions = new Map<string, SqlFunction>();
/** The catalog, loaded on first use; null while the server cannot provide it. */
async function withCatalog() {
  if (!catalog) {
    catalog = await loadCodeCatalog();
    functions = new Map((catalog?.functions || []).map((f) => [f.name, f]));
  }
  return catalog;
}
/** Start loading the catalog before the first suggestion is asked for. */
export const prepareCodeCatalog = () => void withCatalog();

const DIRECTIVE_DOCS: Record<DirectiveName, TranslationKey> = {
  label: "codeDirectiveLabel",
  description: "codeDirectiveDescription",
  input: "codeDirectiveInput",
  param: "codeDirectiveParam",
  output: "codeDirectiveOutput",
  test: "codeDirectiveTest",
  message: "codeDirectiveMessage",
};
const DIRECTIVE_SNIPPETS: Record<DirectiveName, string> = {
  label: "label ${1:Label}",
  description: "description ${1:Description}",
  input: "input ${1:source}",
  param: `param \${1:name}: \${2|${Object.keys(PARAMETER_TYPES).join(",")}|}`,
  output: "output ${1:result}",
  test: "test ${1:name}: ${2|error,warning|}",
  message: "message",
};
const TYPE_DOCS: Record<ParameterType, TranslationKey> = {
  text: "codeTypeText",
  number: "codeTypeNumber",
  boolean: "codeTypeBoolean",
  date: "codeTypeDate",
  choice: "codeTypeChoice",
  keyword: "codeTypeKeyword",
  file: "codeTypeFile",
  destination: "codeTypeDestination",
  connection: "codeTypeConnection",
  secret: "codeTypeSecret",
  column: "codeTypeColumn",
  identifier: "codeTypeIdentifier",
  schema_name: "codeTypeSchemaName",
  table_name: "codeTypeTableName",
  expression: "codeTypeExpression",
  expressions: "codeTypeExpressions",
  schema: "codeTypeSchema",
  list: "codeTypeList",
  column_selection: "codeTypeColumnSelection",
  value_cleaning: "codeTypeValueCleaning",
};
const PROBLEM_MESSAGES: Record<TemplateProblem["code"], TranslationKey> = {
  unknownDirective: "codeProblemUnknownDirective",
  invalidParameter: "codeProblemInvalidParameter",
  unknownParameterType: "codeProblemUnknownParameterType",
  invalidName: "codeProblemInvalidName",
  duplicateName: "codeProblemDuplicateName",
  parameterArgument: "codeProblemParameterArgument",
  undeclaredReference: "codeProblemUndeclaredReference",
  invalidTestName: "codeProblemInvalidTestName",
  duplicateTestName: "codeProblemDuplicateTestName",
  invalidTestSeverity: "codeProblemInvalidTestSeverity",
  messageArguments: "codeProblemMessageArguments",
  emptyCheck: "codeProblemEmptyCheck",
  quotedReference: "codeProblemQuotedReference",
};
const DECLARATION_LABELS: Record<Declaration["kind"], TranslationKey> = {
  input: "codeInput",
  parameter: "codeParameter",
  output: "codeOutput",
};
const SDK_DOCS: Record<string, TranslationKey> = {
  Node: "pythonSdkNode",
  Outputs: "pythonSdkOutputs",
  Relation: "pythonSdkRelation",
  param: "pythonSdkParam",
  Column: "pythonSdkColumn",
  Connection: "pythonSdkConnection",
  File: "pythonSdkFile",
  Destination: "pythonSdkDestination",
  SchemaName: "pythonSdkSchemaName",
  TableName: "pythonSdkTableName",
  Date: "pythonSdkDate",
};
const SELF_MEMBERS: Record<string, [string, TranslationKey]> = {
  message: [
    'message(level: "info" | "warning" | "error", text)',
    "pythonSelfMessage",
  ],
  check: [
    'check(name, failing_rows: dp.Relation, *, severity="error")',
    "pythonSelfCheck",
  ],
  artifact: ["artifact(name) -> Path", "pythonSelfArtifact"],
  db: ["db: duckdb.DuckDBPyConnection", "pythonSelfDb"],
  partition: ["partition: dict | None", "pythonSelfPartition"],
  connection: ["connection(reference) -> dict", "pythonSelfConnection"],
  Outputs: ["Outputs(**outputs)", "pythonSelfOutputs"],
};
const PARAM_KEYWORDS: Record<string, TranslationKey> = {
  default: "pythonParamDefault",
  label: "pythonParamLabel",
  description: "pythonParamDescription",
  ge: "pythonParamBound",
  gt: "pythonParamBound",
  le: "pythonParamBound",
  lt: "pythonParamBound",
  choices: "pythonParamChoices",
  input: "pythonParamInput",
  connection: "pythonParamConnection",
  schema: "pythonParamSchema",
};

/** Inline code, with backticks inside the text kept as they are. */
/** An entry of a lookup table, never an inherited key such as `constructor`. */
const own = <T>(table: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

const code = (text: string) =>
  text.includes("`") ? "`` " + text + " ``" : "`" + text + "`";
const markdown = (value: string): Markdown => ({ value });
const json = (value: unknown) =>
  value === undefined ? "" : JSON.stringify(value);

// ---- Highlighting --------------------------------------------------------

/** Common clauses beyond the reserved keywords, still colored as keywords. */
const CLAUSES = [
  "copy",
  "insert",
  "update",
  "delete",
  "values",
  "replace",
  "exclude",
  "over",
  "partition",
  "rows",
  "preceding",
  "following",
  "unbounded",
  "current",
  "nulls",
  "exists",
  "view",
  "recursive",
  "materialized",
  "filter",
  "within",
  "ordinality",
  "sample",
  "if",
];
const TYPES = [
  "bigint",
  "bit",
  "blob",
  "bool",
  "boolean",
  "date",
  "decimal",
  "double",
  "enum",
  "float",
  "hugeint",
  "int",
  "integer",
  "interval",
  "json",
  "list",
  "map",
  "numeric",
  "real",
  "smallint",
  "struct",
  "time",
  "timestamp",
  "timestamptz",
  "tinyint",
  "ubigint",
  "uhugeint",
  "uinteger",
  "usmallint",
  "utinyint",
  "uuid",
  "varchar",
  "variant",
];

/** DuckDB SQL with Duckpad's `-- @` directives and `{{ name }}` references. */
const SQL_LANGUAGE: monaco.languages.IMonarchLanguage = {
  defaultToken: "",
  tokenPostfix: ".sql",
  ignoreCase: true,
  brackets: [
    { open: "[", close: "]", token: "delimiter.square" },
    { open: "(", close: ")", token: "delimiter.parenthesis" },
    { open: "{", close: "}", token: "delimiter.curly" },
  ],
  keywords: [...RESERVED_KEYWORDS, ...CLAUSES],
  types: TYPES,
  tokenizer: {
    root: [
      [
        /(--\s*@)(label|description)(.*)/,
        ["keyword.directive", "keyword.directive", "comment.doc"],
      ],
      [
        /(--\s*@)(param)(\s+)(\w+)(\s*:\s*)([^=]*?)(\s*=\s*)(.*)/,
        [
          "keyword.directive",
          "keyword.directive",
          "",
          "variable.declaration",
          "delimiter",
          "type",
          "delimiter",
          "string",
        ],
      ],
      [
        /(--\s*@)(param)(\s+)(\w+)(\s*:\s*)(.*)/,
        [
          "keyword.directive",
          "keyword.directive",
          "",
          "variable.declaration",
          "delimiter",
          "type",
        ],
      ],
      [
        /(--\s*@)(input|output|test)(\s+)(\w+)(.*)/,
        [
          "keyword.directive",
          "keyword.directive",
          "",
          "variable.declaration",
          "comment",
        ],
      ],
      [
        /(--\s*@)(\w+)(.*)/,
        ["keyword.directive", "keyword.directive", "comment"],
      ],
      [/{{\s*[\w.]*\s*}}/, "variable.reference"],
      [/--.*/, "comment"],
      [/\/\*/, { token: "comment.quote", next: "@comment" }],
      [/\s+/, "white"],
      [/0[xX][0-9a-fA-F]+/, "number"],
      [/((\d+(\.\d*)?)|(\.\d+))([eE][-+]?\d+)?/, "number"],
      [/[eE]?'/, { token: "string", next: "@string" }],
      [/"/, { token: "identifier.quote", next: "@quotedIdentifier" }],
      [/[;,.]/, "delimiter"],
      [/[()[\]{}]/, "@brackets"],
      [/::/, "operator"],
      // A name followed by a parenthesis calls a function, unless it is a keyword.
      [
        /\w+(?=\s*\()/,
        { cases: { "@keywords": "keyword", "@default": "predefined" } },
      ],
      [
        /[\w$]+/,
        {
          cases: {
            "@types": "type",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],
      [/[<>=!%&+\-*/|~^:@]/, "operator"],
    ],
    comment: [
      [/[^*/]+/, "comment"],
      [/\*\//, { token: "comment.quote", next: "@pop" }],
      [/./, "comment"],
    ],
    string: [
      [/[^']+/, "string"],
      [/''/, "string"],
      [/'/, { token: "string", next: "@pop" }],
    ],
    quotedIdentifier: [
      [/[^"]+/, "identifier"],
      [/""/, "identifier"],
      [/"/, { token: "identifier.quote", next: "@pop" }],
    ],
  },
};

const SQL_CONFIGURATION: monaco.languages.LanguageConfiguration = {
  comments: { lineComment: "--", blockComment: ["/*", "*/"] },
  brackets: [
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"', notIn: ["string"] },
    { open: "'", close: "'", notIn: ["string", "comment"] },
  ],
  surroundingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: "(", close: ")" },
    { open: '"', close: '"' },
    { open: "'", close: "'" },
  ],
};

/** Light and dark themes that color Duckpad's directives and references. */
export const EDITOR_THEMES = { light: "duckpad-light", dark: "duckpad-dark" };
// ---- SQL -----------------------------------------------------------------

const lineRange = (position: Position, start: number, end = position.column) =>
  new monaco.Range(position.lineNumber, start, position.lineNumber, end);

/** The text of a block from its first line to the cursor, or to its end. */
function blockText(
  model: Model,
  outline: TemplateOutline | null,
  position: Position,
  whole = false,
) {
  const block = outline ? blockAt(outline, position.lineNumber) : null;
  const start = block ? block.line : Math.max(1, position.lineNumber - 50);
  return whole && block
    ? model.getValueInRange(
        new monaco.Range(
          start,
          1,
          block.end,
          model.getLineMaxColumn(block.end),
        ),
      )
    : model.getValueInRange(
        new monaco.Range(start, 1, position.lineNumber, position.column),
      );
}

function declarationKind(kind: Declaration["kind"]) {
  return kind === "input"
    ? Kind.Variable
    : kind === "parameter"
      ? Kind.Property
      : Kind.Reference;
}

function columnTable(columns: CodeInput["columns"], t: Translate) {
  if (!columns?.length) return "";
  const shown = columns.slice(0, 12);
  const rows = shown.map((c) => `| ${code(c.name)} | ${c.type} |`);
  if (columns.length > shown.length)
    rows.push(
      `| ${t("codeMoreColumns").replace("{count}", String(columns.length - shown.length))} | |`,
    );
  return `\n\n| | |\n|---|---|\n${rows.join("\n")}`;
}

function inputSummary(input: CodeInput | undefined, t: Translate) {
  if (!input) return "";
  const origin =
    input.origin === "result"
      ? t("columnsFromResult")
      : input.origin === "description"
        ? t("columnsFromCode")
        : t(input.source ? "columnsUnavailable" : "inputNotConnected");
  return (
    (input.source ? `\n\n${t("codeConnectedTo")} ${code(input.source)}` : "") +
    `\n\n_${origin}_` +
    columnTable(input.columns, t)
  );
}

/** The columns of an input, or of an output the node computed. */
const tableOf = (context: Context, name: string) =>
  context.inputs?.find((input) => input.name === name) ??
  context.outputs?.find((output) => output.name === name);

function declarationHover(d: Declaration, context: Context): Markdown {
  const { t } = context;
  let text = `**${t(DECLARATION_LABELS[d.kind])}** ${code(d.name)}`;
  if (d.kind === "parameter") {
    text += `: ${code(d.type!)}`;
    if (d.default !== undefined)
      text += `\n\n${t("codeDefault")} ${code(d.default)}`;
    const value = context.parameters?.[d.name];
    if (value?.variable)
      text += `\n\n${t("codeBoundVariable")
        .replace("{name}", code(value.variable))
        .replace("{environment}", context.environment ?? "")}${
        value.value !== undefined ? ` ${code(json(value.value))}` : ""
      }`;
    else if (value && value.value !== undefined)
      text += `\n\n${t("codeNodeValue")} ${code(json(value.value))}`;
    const doc = own(TYPE_DOCS, baseOf(d.type!));
    if (doc) text += `\n\n${t(doc)}`;
  } else if (d.kind === "input")
    text += inputSummary(
      context.inputs?.find((input) => input.name === d.name),
      context.t,
    );
  else
    text +=
      `\n\n${t("codeDeclaredLine").replace("{line}", String(d.line))}` +
      columnTable(tableOf(context, d.name)?.columns ?? null, t);
  return markdown(text);
}

const baseOf = (type: string) => type.trim().split(/[<(]/)[0].trim();

function signatureLabel(name: string, s: SqlFunction["signatures"][number]) {
  const parameters = s.parameters.map((p) =>
    p.type ? `${p.name} ${p.type}` : p.name,
  );
  if (s.varargs) parameters.push("…");
  return `${name}(${parameters.join(", ")})${s.returns ? " → " + s.returns : ""}`;
}

function functionDocs(f: SqlFunction, t: Translate): Markdown {
  let text = f.description || "";
  if (f.examples.length)
    text += `\n\n${f.examples.map((example) => "```sql\n" + example + "\n```").join("\n")}`;
  if (f.options?.length)
    text += `\n\n${t("codeTableOptions")} ${f.options.map((o) => code(o.name)).join(", ")}`;
  return markdown(text);
}

function functionHover(f: SqlFunction, t: Translate): Markdown {
  return markdown(
    "```sql\n" +
      f.signatures.map((s) => signatureLabel(f.name, s)).join("\n") +
      "\n```\n\n" +
      functionDocs(f, t).value,
  );
}

/** The columns of every input, those the block reads first. */
function columnItems(
  context: Context,
  read: Set<string>,
  range: monaco.IRange,
  quote: (name: string) => string,
): Item[] {
  const found = new Map<string, Item>();
  const tables = [
    ...(context.inputs || []),
    ...(context.outputs || []).filter((output) => read.has(output.name)),
  ];
  for (const input of tables)
    for (const column of input.columns || []) {
      const known = found.get(column.name);
      if (known) {
        known.detail += `, ${input.name}`;
        continue;
      }
      found.set(column.name, {
        label: column.name,
        kind: Kind.Field,
        detail: `${column.type} · ${input.name}`,
        insertText: quote(column.name),
        sortText: (read.has(input.name) ? "1" : "2") + column.name,
        range,
      });
    }
  return [...found.values()];
}

let staticSqlItems: Omit<Item, "range">[] | null = null;
let staticLanguage = "";
/** Functions and keywords from the catalog, built once per language. */
function sqlCatalogItems(t: Translate) {
  if (!catalog) return [];
  if (staticSqlItems && staticLanguage === t("codeTableOptions"))
    return staticSqlItems;
  staticLanguage = t("codeTableOptions");
  staticSqlItems = [
    ...catalog.functions.map((f) => ({
      label: f.name,
      kind: f.kind.startsWith("table") ? Kind.Module : Kind.Function,
      detail: f.signatures[0] ? signatureLabel(f.name, f.signatures[0]) : "",
      documentation: functionDocs(f, t),
      insertText: f.name + "($0)",
      insertTextRules: Rule.InsertAsSnippet,
      command: { id: "editor.action.triggerParameterHints", title: "" },
      sortText: "3" + f.name,
    })),
    ...catalog.keywords.map((k) => ({
      label: k.name,
      kind: Kind.Keyword,
      insertText: k.name,
      sortText: "4" + k.name,
    })),
  ];
  return staticSqlItems;
}

async function sqlCompletions(
  model: Model,
  position: Position,
): Promise<monaco.languages.CompletionList> {
  const context = contexts.get(model);
  if (!context) return { suggestions: [] };
  const { t } = context;
  const lineText = model.getLineContent(position.lineNumber);
  const before = lineText.slice(0, position.column - 1);
  const after = lineText.slice(position.column - 1);
  const word = model.getWordUntilPosition(position);
  const range = lineRange(
    position,
    word.startColumn,
    model.getWordAtPosition(position)?.endColumn ?? word.endColumn,
  );
  const cursor = sqlCursor(before);
  const outline = context.template ? outlineTemplate(model.getValue()) : null;
  const declarations = outline?.declarations || [];
  const parameters = declarations.filter((d) => d.kind === "parameter");
  const inputs = declarations.filter((d) => d.kind === "input");
  const named = (names: string[], kind = Kind.Variable): Item[] =>
    names.map((name) => ({ label: name, kind, insertText: name, range }));
  switch (cursor.kind) {
    case "directive":
      return {
        suggestions: outline
          ? DIRECTIVES.map((directive) => ({
              label: "@" + directive,
              filterText: directive,
              kind: Kind.Keyword,
              documentation: markdown(t(DIRECTIVE_DOCS[directive])),
              insertText: DIRECTIVE_SNIPPETS[directive],
              insertTextRules: Rule.InsertAsSnippet,
              sortText: String(DIRECTIVES.indexOf(directive)),
              range,
            }))
          : [],
      };
    case "parameterType":
      return {
        suggestions: (Object.keys(PARAMETER_TYPES) as ParameterType[]).map(
          (type) => {
            const argument = PARAMETER_TYPES[type];
            const choices = (names: string[], fallback: string) =>
              names.length ? `\${1|${names.join(",")}|}` : `\${1:${fallback}}`;
            const insertText =
              argument === "connection"
                ? `${type}(${choices(
                    parameters
                      .filter((p) => p.type === "connection")
                      .map((p) => p.name),
                    "connection",
                  )})`
                : argument === "input"
                  ? `${type}(${choices(
                      inputs.map((i) => i.name),
                      "source",
                    )})`
                  : argument === "schema"
                    ? `${type}(${choices(
                        parameters
                          .filter((p) => baseOf(p.type!) === "schema_name")
                          .map((p) => p.name),
                        "schema",
                      )})`
                    : argument === "options"
                      ? `${type}(\${1:a}|\${2:b})`
                      : argument === "item"
                        ? `list<\${1|${LIST_ITEM_TYPES.join(",")}|}>`
                        : type;
            return {
              label: type,
              kind: Kind.TypeParameter,
              documentation: markdown(t(TYPE_DOCS[type])),
              insertText,
              insertTextRules: Rule.InsertAsSnippet,
              range,
            };
          },
        ),
      };
    case "typeArgument": {
      const argument = PARAMETER_TYPES[cursor.type];
      return {
        suggestions:
          argument === "connection"
            ? named(
                parameters
                  .filter((p) => p.type === "connection")
                  .map((p) => p.name),
                Kind.Property,
              )
            : argument === "input"
              ? named(inputs.map((i) => i.name))
              : argument === "schema"
                ? named(
                    parameters
                      .filter((p) => baseOf(p.type!) === "schema_name")
                      .map((p) => p.name),
                    Kind.Property,
                  )
                : argument === "item"
                  ? named(LIST_ITEM_TYPES, Kind.TypeParameter)
                  : [],
      };
    }
    case "parameterDefault": {
      // Values are strings, not words: a connection ID or choice can include
      // spaces, hyphens and escaped quotes. Replace the whole value, including
      // its suffix when completing in the middle of an existing default.
      const suffix = cursor.quoted
        ? /^(?:\\.|[^"\\])*/.exec(after)![0]
        : after.trimEnd();
      const valueRange = lineRange(
        position,
        position.column - cursor.prefix.length,
        position.column + suffix.length,
      );
      const quote = (value: string) =>
        cursor.quoted
          ? JSON.stringify(value).slice(1, -1) +
            (after[suffix.length] === '"' ? "" : '"')
          : JSON.stringify(value);
      const base = baseOf(cursor.type);
      const options =
        base === "connection"
          ? (context.connections || []).map((c) => ({
              label: c.id,
              detail: c.name,
              kind: Kind.Value,
              insertText: quote(c.id),
              range: valueRange,
            }))
          : base === "choice" || base === "keyword"
            ? (/\((.*)\)/.exec(cursor.type)?.[1] || "")
                .split("|")
                .filter(Boolean)
                .map((option) => ({
                  label: option.trim(),
                  kind: Kind.EnumMember,
                  insertText: quote(option.trim()),
                  range: valueRange,
                }))
            : base === "boolean" && !cursor.quoted
              ? named(["true", "false"], Kind.Value)
              : [];
      if (base === "connection" && !cursor.quoted)
        options.unshift({
          label: '""',
          detail: t("projectFiles"),
          kind: Kind.Value,
          insertText: '""',
          range: valueRange,
        });
      return { suggestions: options };
    }
    case "testSeverity":
      return { suggestions: named(["error", "warning"], Kind.EnumMember) };
    case "declaration":
    case "comment":
    case "string":
      return { suggestions: [] };
    case "reference": {
      const available = outline
        ? referencesAt(outline, position.lineNumber)
        : [];
      const remaining = lineText.slice(range.endColumn - 1);
      const closing = /^\s*}}/.test(remaining)
        ? remaining.startsWith(" ")
          ? ""
          : " "
        : " }}";
      return {
        suggestions: available.map((d) => ({
          label: d.name,
          kind: declarationKind(d.kind),
          detail: t(DECLARATION_LABELS[d.kind]),
          documentation: declarationHover(d, context),
          insertText: (cursor.spaced ? "" : " ") + d.name + closing,
          range,
        })),
      };
    }
    case "member": {
      const aliases = inputAliases(blockText(model, outline, position, true));
      const table =
        aliases.get(cursor.owner) ??
        (declarations.some((d) => d.name === cursor.owner)
          ? cursor.owner
          : null);
      if (!table) return { suggestions: [] };
      const owned = {
        ...context,
        inputs: tableOf(context, table) ? [tableOf(context, table)!] : [],
        outputs: [],
      };
      const input = table;
      return {
        suggestions: columnItems(owned, new Set([input]), range, (name) =>
          quoteIdentifier(name),
        ),
      };
    }
    case "cast":
      await withCatalog();
      return {
        suggestions: (catalog?.types || []).map((type) => ({
          label: type,
          kind: Kind.TypeParameter,
          insertText: type,
          range,
        })),
      };
    case "sql": {
      await withCatalog();
      const block = blockText(model, outline, position);
      const read = new Set(
        [...block.matchAll(/{{\s*(\w+)\s*}}/g)].map((match) => match[1]),
      );
      const suggestions: Item[] = [];
      const call = enclosingCall(block);
      const options = call && functions.get(call.name)?.options;
      if (options && call.argument >= 1)
        for (const option of options)
          if (!call.named.includes(option.name))
            suggestions.push({
              label: option.name,
              kind: Kind.Property,
              detail: option.type,
              insertText: option.name + " = ",
              sortText: "0" + option.name,
              range,
            });
      if (outline)
        for (const d of referencesAt(outline, position.lineNumber))
          suggestions.push({
            label: `{{ ${d.name} }}`,
            filterText: d.name,
            kind: declarationKind(d.kind),
            detail: t(DECLARATION_LABELS[d.kind]),
            documentation: declarationHover(d, context),
            insertText: `{{ ${d.name} }}`,
            sortText: "0" + d.name,
            range,
          });
      suggestions.push(...columnItems(context, read, range, quoteIdentifier));
      const calling = lineText
        .slice(range.endColumn - 1)
        .trimStart()
        .startsWith("(");
      // Functions and keywords match the start of the word only: among a
      // thousand names, loose matches would turn most words into a function.
      const typed = cursor.prefix.toLowerCase();
      for (const item of sqlCatalogItems(t))
        if ((item.label as string).toLowerCase().startsWith(typed))
          suggestions.push(
            calling && item.kind !== Kind.Keyword
              ? {
                  ...item,
                  insertText: item.label as string,
                  insertTextRules: undefined,
                  command: undefined,
                  range,
                }
              : { ...item, range },
          );
      // Ask again as the word grows, so that the filter above applies.
      return { suggestions, incomplete: true };
    }
  }
}

async function sqlHover(
  model: Model,
  position: Position,
): Promise<monaco.languages.Hover | null> {
  const context = contexts.get(model);
  if (!context) return null;
  const { t } = context;
  const lineText = model.getLineContent(position.lineNumber);
  const column = position.column;
  const outline = context.template ? outlineTemplate(model.getValue()) : null;
  const declared = (name: string) =>
    outline?.declarations.find((d) => d.name === name);
  for (const match of lineText.matchAll(/{{\s*(\w+)\s*}}/g)) {
    const start = match.index + 1;
    const end = start + match[0].length;
    const declaration = declared(match[1]);
    if (column >= start && column <= end && declaration)
      return {
        range: lineRange(position, start, end),
        contents: [declarationHover(declaration, context)],
      };
  }
  const directive = outline && readDirective(lineText);
  if (directive) {
    const keyEnd = directive.keyColumn + directive.key.length;
    if (column >= directive.keyColumn - 1 && column <= keyEnd) {
      const doc = own(DIRECTIVE_DOCS, directive.key);
      return doc
        ? {
            range: lineRange(position, directive.keyColumn - 1, keyEnd),
            contents: [markdown(`**@${directive.key}**\n\n${t(doc)}`)],
          }
        : null;
    }
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    const declaration = declared(word.word);
    if (declaration?.line === position.lineNumber)
      return { contents: [declarationHover(declaration, context)] };
    const type = own(TYPE_DOCS, word.word);
    if (directive.key === "param" && type)
      return {
        range: lineRange(position, word.startColumn, word.endColumn),
        contents: [markdown(`**${word.word}**\n\n${t(type)}`)],
      };
    return null;
  }
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const range = lineRange(position, word.startColumn, word.endColumn);
  if (/^\s*\(/.test(lineText.slice(word.endColumn - 1))) {
    await withCatalog();
    const f = functions.get(word.word.toLowerCase());
    if (f) return { range, contents: [functionHover(f, t)] };
  }
  const owners = (context.inputs || []).filter((input) =>
    input.columns?.some(
      (c) => c.name.toLowerCase() === word.word.toLowerCase(),
    ),
  );
  if (owners.length)
    return {
      range,
      contents: [
        markdown(
          owners
            .map(
              (input) =>
                `${code(word.word)} ${code(
                  input.columns!.find(
                    (c) => c.name.toLowerCase() === word.word.toLowerCase(),
                  )!.type,
                )} · ${t("codeInput")} ${code(input.name)}`,
            )
            .join("\n\n"),
        ),
      ],
    };
  return null;
}

async function sqlSignatureHelp(
  model: Model,
  position: Position,
): Promise<monaco.languages.SignatureHelpResult | null> {
  const context = contexts.get(model);
  if (!context) return null;
  await withCatalog();
  const outline = context.template ? outlineTemplate(model.getValue()) : null;
  const call = enclosingCall(blockText(model, outline, position));
  const f = call && functions.get(call.name);
  if (!call || !f || !f.signatures.length) return null;
  const signatures = f.signatures.map((s) => {
    const label = signatureLabel(f.name, s);
    let offset = f.name.length + 1;
    const parameters = s.parameters.map((p) => {
      const text = p.type ? `${p.name} ${p.type}` : p.name;
      const start = label.indexOf(text, offset);
      offset = start + text.length;
      return { label: [start, start + text.length] as [number, number] };
    });
    return {
      label,
      parameters,
      documentation: functionDocs(f, context.t),
    };
  });
  const fits = f.signatures.findIndex(
    (s) => s.parameters.length > call.argument || s.varargs,
  );
  const active = fits < 0 ? f.signatures.length - 1 : fits;
  const count = f.signatures[active].parameters.length;
  return {
    value: {
      signatures,
      activeSignature: active,
      activeParameter: Math.min(call.argument, Math.max(count - 1, 0)),
    },
    dispose: () => {},
  };
}

const problemsOf = new WeakMap<Model, TemplateProblem[]>();

/** Mark the problems of a template's text, located where they are. */
export function checkTemplate(model: Model, t: Translate) {
  const problems = lintTemplate(model.getValue());
  problemsOf.set(model, problems);
  monaco.editor.setModelMarkers(
    model,
    "duckpad",
    problems.map((problem) => ({
      severity:
        problem.severity === "error"
          ? monaco.MarkerSeverity.Error
          : monaco.MarkerSeverity.Warning,
      message: t(PROBLEM_MESSAGES[problem.code]).replaceAll(
        "{subject}",
        problem.subject,
      ),
      startLineNumber: problem.line,
      endLineNumber: problem.line,
      startColumn: problem.column,
      endColumn: problem.endColumn,
    })),
  );
}

const HEADER = new Set(["label", "description", "input", "param"]);

/** The line after which a new declaration goes: its kind's last one, or the header's. */
function declarationLine(model: Model, key: "input" | "param") {
  let header = 0;
  let same = 0;
  for (let line = 1; line <= model.getLineCount(); line++) {
    const text = model.getLineContent(line);
    const found = readDirective(text);
    if (found && HEADER.has(found.key)) {
      header = line;
      if (found.key === key) same = line;
    } else if (text.trim()) break;
  }
  return same || header;
}

/** The directive a misspelled one most likely means. */
const closestDirective = (key: string) =>
  DIRECTIVES.find(
    (directive) =>
      key.toLowerCase() === directive ||
      key.toLowerCase().startsWith(directive) ||
      directive.startsWith(key.toLowerCase()),
  );

/** Quick fixes for the problems the editor located. */
function sqlCodeActions(
  model: Model,
  range: monaco.Range,
  actionContext: monaco.languages.CodeActionContext,
): monaco.languages.CodeActionList {
  const context = contexts.get(model);
  const actions: monaco.languages.CodeAction[] = [];
  const list = { actions, dispose: () => {} };
  if (!context?.template) return list;
  const { t } = context;
  const outline = outlineTemplate(model.getValue());
  for (const problem of problemsOf.get(model) || []) {
    const span = new monaco.Range(
      problem.line,
      problem.column,
      problem.line,
      problem.endColumn,
    );
    if (!span.intersectRanges(range) && !range.containsRange(span)) continue;
    const marker = actionContext.markers.find(
      (m) =>
        m.startLineNumber === problem.line && m.startColumn === problem.column,
    );
    const fix = (title: string, edit: monaco.IRange, text: string) =>
      actions.push({
        title,
        kind: "quickfix",
        diagnostics: marker ? [marker] : undefined,
        isPreferred: actions.length === 0,
        edit: {
          edits: [
            {
              resource: model.uri,
              textEdit: { range: edit, text },
              versionId: model.getVersionId(),
            },
          ],
        },
      });
    const name = problem.subject;
    if (
      problem.code === "undeclaredReference" &&
      !outline.declarations.some((d) => d.name === name)
    ) {
      for (const [key, title, text] of [
        ["input", "codeFixDeclareInput", `-- @input ${name}\n`],
        ["param", "codeFixDeclareParameter", `-- @param ${name}: text\n`],
      ] as const) {
        const line = declarationLine(model, key) + 1;
        fix(
          t(title).replace("{name}", name),
          new monaco.Range(line, 1, line, 1),
          text,
        );
      }
    } else if (problem.code === "quotedReference")
      fix(
        t("codeFixRemoveQuotes"),
        span,
        model.getValueInRange(span).slice(1, -1),
      );
    else if (problem.code === "invalidTestSeverity")
      for (const severity of ["error", "warning"])
        fix(t("codeFixChangeTo").replace("{text}", severity), span, severity);
    else if (problem.code === "unknownDirective") {
      const directive = closestDirective(name);
      if (directive)
        fix(
          t("codeFixChangeTo").replace("{text}", "@" + directive),
          span,
          directive,
        );
    } else if (problem.code === "messageArguments") {
      // Keep "-- @message", drop what follows it.
      const text = model.getLineContent(problem.line);
      const kept = text.indexOf("@message") + "@message".length + 1;
      fix(
        t("codeFixRemoveArguments"),
        new monaco.Range(
          problem.line,
          kept,
          problem.line,
          model.getLineMaxColumn(problem.line),
        ),
        "",
      );
    }
  }
  return list;
}

/** Remove the checks of a text that is no longer a template. */
export function clearTemplateChecks(model: Model) {
  problemsOf.delete(model);
  monaco.editor.setModelMarkers(model, "duckpad", []);
}

/** Whether the editor checks found an error in the text. */
export const hasEditorErrors = (model: Model) =>
  monaco.editor
    .getModelMarkers({ resource: model.uri, owner: "duckpad" })
    .some((marker) => marker.severity === monaco.MarkerSeverity.Error);

// ---- Python --------------------------------------------------------------

function memberItems(
  members: PythonMember[],
  range: monaco.IRange,
  sortPrefix = "1",
): Item[] {
  return members.map((m) => ({
    label: m.name,
    kind:
      m.kind === "property"
        ? Kind.Property
        : m.kind === "class"
          ? Kind.Class
          : Kind.Method,
    detail: m.signature ? m.name + m.signature : "",
    documentation: m.doc,
    insertText: m.name,
    sortText: sortPrefix + m.name,
    range,
  }));
}

const sdkItems = (t: Translate, range: monaco.IRange): Item[] =>
  Object.entries(SDK_DOCS).map(([name, doc]) => ({
    label: name,
    kind: name === "param" ? Kind.Function : Kind.Class,
    documentation: markdown(t(doc)),
    insertText: name,
    range,
  }));

async function pythonCompletions(
  model: Model,
  position: Position,
): Promise<monaco.languages.CompletionList> {
  const context = contexts.get(model);
  if (!context?.template) return { suggestions: [] };
  const { t } = context;
  const before = model
    .getLineContent(position.lineNumber)
    .slice(0, position.column - 1);
  const word = model.getWordUntilPosition(position);
  const range = lineRange(
    position,
    word.startColumn,
    model.getWordAtPosition(position)?.endColumn ?? word.endColumn,
  );
  const outline = outlinePython(model.getValue());
  const cursor = pythonCursor(before);
  const named = (names: string[], kind = Kind.Variable): Item[] =>
    names.map((name) => ({ label: name, kind, insertText: name, range }));
  const annotated = (suffix: string) =>
    outline.parameters
      .filter((p) => p.annotation.endsWith(suffix))
      .map((p) => p.name);
  if (cursor.kind === "member") {
    const { owner } = cursor;
    if (owner === outline.sdk) return { suggestions: sdkItems(t, range) };
    if (owner === "self")
      return {
        suggestions: [
          ...outline.parameters.map((p) => ({
            label: p.name,
            kind: Kind.Field,
            detail: p.annotation,
            documentation: markdown(
              `**${t("codeParameter")}** ${code(p.name)}: ${code(p.annotation)}`,
            ),
            insertText: p.name,
            sortText: "0" + p.name,
            range,
          })),
          ...Object.entries(SELF_MEMBERS).map(([name, [signature, doc]]) => ({
            label: name,
            kind: Kind.Method,
            detail: signature,
            documentation: markdown(t(doc)),
            insertText: name,
            sortText: "1" + name,
            range,
          })),
        ],
      };
    await withCatalog();
    if (owner === "self.db")
      return {
        suggestions: memberItems(catalog?.python.connection || [], range),
      };
    if (outline.inputs.includes(owner))
      return {
        suggestions: memberItems(catalog?.python.relation || [], range),
      };
    if (outline.duckdb.includes(owner))
      return { suggestions: memberItems(catalog?.python.module || [], range) };
    return { suggestions: [] };
  }
  if (cursor.kind === "keyword") {
    if (cursor.call === `${outline.sdk}.param`)
      return {
        suggestions: Object.entries(PARAM_KEYWORDS)
          .filter(([name]) => !cursor.given.includes(name))
          .map(([name, doc]) => ({
            label: name + "=",
            filterText: name,
            kind: Kind.Property,
            documentation: markdown(t(doc)),
            insertText: name + "=",
            sortText: "0" + name,
            range,
          })),
      };
    if (cursor.call === "self.check" && !cursor.given.includes("severity"))
      return { suggestions: named(["severity="], Kind.Property) };
    return { suggestions: [] };
  }
  if (cursor.kind === "string") {
    const purpose = stringPurpose(cursor.context, outline.sdk);
    const stringRange = lineRange(
      position,
      position.column - cursor.prefix.length,
    );
    const values =
      purpose === "input"
        ? outline.inputs
        : purpose === "connection"
          ? annotated("Connection")
          : purpose === "schema"
            ? annotated("SchemaName")
            : purpose === "level"
              ? ["info", "warning", "error"]
              : purpose === "severity"
                ? ["error", "warning"]
                : null;
    if (values)
      return {
        suggestions: values.map((name) => ({
          label: name,
          kind: Kind.Value,
          insertText: name,
          range: stringRange,
        })),
      };
    if (purpose === "column")
      return {
        suggestions: columnItems(context, new Set(), stringRange, (n) => n),
      };
    if (purpose === "expression") {
      const sql = sqlCursor(cursor.prefix);
      if (sql.kind === "string" || sql.kind === "comment")
        return { suggestions: [] };
      const quote = before[before.length - cursor.prefix.length - 1];
      return {
        suggestions: columnItems(context, new Set(), range, (name) =>
          quoteIdentifier(name)
            .replaceAll("\\", "\\\\")
            .replaceAll(quote, "\\" + quote),
        ),
      };
    }
  }
  return { suggestions: [] };
}

async function pythonHover(
  model: Model,
  position: Position,
): Promise<monaco.languages.Hover | null> {
  const context = contexts.get(model);
  if (!context?.template) return null;
  const { t } = context;
  const word = model.getWordAtPosition(position);
  if (!word) return null;
  const range = lineRange(position, word.startColumn, word.endColumn);
  const lineText = model.getLineContent(position.lineNumber);
  const owner = /((?:\w+\.)*\w+)\.$/.exec(
    lineText.slice(0, word.startColumn - 1),
  )?.[1];
  const outline = outlinePython(model.getValue());
  const name = word.word;
  const hover = (text: string) => ({ range, contents: [markdown(text)] });
  const sdk = own(SDK_DOCS, name);
  if (owner && owner === outline.sdk && sdk)
    return hover(`**${owner}.${name}**\n\n${t(sdk)}`);
  if (owner === "self") {
    const parameter = outline.parameters.find((p) => p.name === name);
    if (parameter)
      return hover(
        `**${t("codeParameter")}** ${code(name)}: ${code(parameter.annotation)}`,
      );
    const member = own(SELF_MEMBERS, name);
    if (member) return hover(`${code("self." + member[0])}\n\n${t(member[1])}`);
    return null;
  }
  if (!owner && outline.inputs.includes(name)) {
    const input = context.inputs?.find((i) => i.name === name);
    return hover(
      `**${t("codeInput")}** ${code(name)}: ${code("dp.Relation")}` +
        inputSummary(input, t),
    );
  }
  if (!owner) return null;
  await withCatalog();
  const members =
    owner === "self.db"
      ? catalog?.python.connection
      : outline.inputs.includes(owner)
        ? catalog?.python.relation
        : outline.duckdb.includes(owner)
          ? catalog?.python.module
          : undefined;
  const member = members?.find((m) => m.name === name);
  return member
    ? hover(
        "```python\n" +
          member.name +
          member.signature +
          "\n```\n\n" +
          member.doc,
      )
    : null;
}

// ---- Project files -------------------------------------------------------

async function jsonCompletions(
  model: Model,
  position: Position,
): Promise<monaco.languages.CompletionList> {
  const context = contexts.get(model);
  const before = model
    .getLineContent(position.lineNumber)
    .slice(0, position.column - 1);
  const reference = /"\$var"\s*:\s*"([^"]*)$/.exec(before);
  if (context?.file !== "flow.json" || !reference) return { suggestions: [] };
  const range = lineRange(position, position.column - reference[1].length);
  return {
    suggestions: (context.variables || []).map((variable) => ({
      label: variable.name,
      kind: Kind.Variable,
      detail: variable.type,
      documentation: markdown(
        [
          variable.description,
          variable.value !== undefined
            ? `${context.environment}: ${code(json(variable.value))}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
      insertText: variable.name,
      range,
    })),
  };
}

let registered = false;
/** Register the languages and providers, once. */
export function registerCodeIntelligence() {
  if (registered) return;
  registered = true;
  monaco.editor.defineTheme(EDITOR_THEMES.light, {
    base: "vs",
    inherit: true,
    colors: {},
    rules: [
      { token: "keyword.directive", foreground: "8250df", fontStyle: "bold" },
      { token: "variable.declaration", foreground: "0550ae" },
      { token: "variable.reference", foreground: "a1460b", fontStyle: "bold" },
      { token: "comment.doc", foreground: "57606a", fontStyle: "italic" },
      { token: "predefined", foreground: "6f42c1" },
    ],
  });
  monaco.editor.defineTheme(EDITOR_THEMES.dark, {
    base: "vs-dark",
    inherit: true,
    colors: {},
    rules: [
      { token: "keyword.directive", foreground: "d2a8ff", fontStyle: "bold" },
      { token: "variable.declaration", foreground: "79c0ff" },
      { token: "variable.reference", foreground: "ffa657", fontStyle: "bold" },
      { token: "comment.doc", foreground: "8b949e", fontStyle: "italic" },
      { token: "predefined", foreground: "dcdcaa" },
    ],
  });
  monaco.languages.register({
    id: "sql",
    extensions: [".sql"],
    aliases: ["SQL", "sql"],
  });
  monaco.languages.setMonarchTokensProvider("sql", SQL_LANGUAGE);
  monaco.languages.setLanguageConfiguration("sql", SQL_CONFIGURATION);
  monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: ["@", "{", ".", ":", "(", '"', ","],
    provideCompletionItems: sqlCompletions,
  });
  monaco.languages.registerHoverProvider("sql", { provideHover: sqlHover });
  monaco.languages.registerCodeActionProvider(
    "sql",
    { provideCodeActions: sqlCodeActions },
    { providedCodeActionKinds: ["quickfix"] },
  );
  monaco.languages.registerSignatureHelpProvider("sql", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp: sqlSignatureHelp,
  });
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: [".", '"', "'", "(", ","],
    provideCompletionItems: pythonCompletions,
  });
  monaco.languages.registerHoverProvider("python", {
    provideHover: pythonHover,
  });
  monaco.languages.registerCompletionItemProvider("json", {
    triggerCharacters: ['"'],
    provideCompletionItems: jsonCompletions,
  });
}
