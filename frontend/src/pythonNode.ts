/**
 * Read a Python node as the editor sees it, without Monaco: the names its
 * code declares and what the text before the cursor expects next. The
 * contract itself is read on the server by `python_contract.py`.
 */

export interface PythonParameter {
  name: string;
  /** The annotation as written, such as `int` or `dp.Column`. */
  annotation: string;
  line: number;
}
export interface PythonOutline {
  /** The name `duckpad` is imported as. */
  sdk: string | null;
  /** The names `duckdb` is imported as. */
  duckdb: string[];
  parameters: PythonParameter[];
  /** The named arguments of `run`, each a tabular input. */
  inputs: string[];
  outputs: string[];
}

const indentation = (line: string) => /^\s*/.exec(line)![0].length;

export function outlinePython(text: string): PythonOutline {
  const lines = text.split(/\r?\n/);
  const outline: PythonOutline = {
    sdk: null,
    duckdb: [],
    parameters: [],
    inputs: [],
    outputs: [],
  };
  for (const line of lines) {
    const sdk = /^\s*import\s+duckpad(?:\s+as\s+(\w+))?\s*$/.exec(line);
    if (sdk) outline.sdk = sdk[1] ?? "duckpad";
    const duckdb = /^\s*import\s+duckdb(?:\s+as\s+(\w+))?\s*$/.exec(line);
    if (duckdb) outline.duckdb.push(duckdb[1] ?? "duckdb");
  }
  const sdk = outline.sdk;
  if (!sdk) return outline;
  const node = lines.findIndex((line) =>
    new RegExp(String.raw`^class\s+\w+\s*\(\s*${sdk}\.Node\s*\)\s*:`).test(
      line,
    ),
  );
  if (node < 0) return outline;
  // The class body ends at the next line indented like the class or less.
  let body = -1;
  // A class nested in the node, such as Outputs, with the indentation of its body.
  let nested: { name: string; indent: number } | null = null;
  const declared: Record<string, string[]> = {};
  // Docstrings and other multi-line strings hold text, not declarations.
  let quoted = false;
  for (let index = node + 1; index < lines.length; index++) {
    const line = lines[index];
    const quotes = (line.match(/"""|'''/g) || []).length;
    const inString = quoted || quotes > 0;
    if (quotes % 2) quoted = !quoted;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (inString) continue;
    const indent = indentation(line);
    if (indent === 0) break;
    if (body < 0) body = indent;
    if (indent === body) {
      const inner = /^\s*class\s+(\w+)\s*\(/.exec(line);
      nested = inner ? { name: inner[1], indent: -1 } : null;
      if (inner) declared[inner[1]] = [];
      const attribute = /^\s*(\w+)\s*:\s*([^=]+?)\s*(?:=.*)?$/.exec(line);
      if (attribute && !/^ClassVar\b|\.ClassVar\b/.test(attribute[2]))
        outline.parameters.push({
          name: attribute[1],
          annotation: attribute[2],
          line: index + 1,
        });
    } else if (nested && indent > body) {
      if (nested.indent < 0) nested.indent = indent;
      const attribute = /^\s*(\w+)\s*:/.exec(line);
      if (attribute && indent === nested.indent)
        declared[nested.name].push(attribute[1]);
    }
  }
  const run = /\bdef\s+run\s*\(([^)]*)\)\s*(?:->\s*([^:]+))?:/.exec(
    lines.slice(node).join("\n"),
  );
  if (run) {
    outline.inputs = topLevel(run[1])
      .map((argument) => /^\s*(\w+)/.exec(argument)?.[1] ?? "")
      .filter((name) => name && name !== "self");
    const returned = (run[2] ?? "").trim();
    outline.outputs =
      returned === "None"
        ? []
        : returned.endsWith("Relation")
          ? ["result"]
          : (declared[returned.split(".").pop()!] ?? []);
  }
  return outline;
}

/** Arguments separated by commas outside brackets: `a: dict[str, int], b`. */
function topLevel(text: string) {
  const parts = [""];
  let depth = 0;
  for (const char of text) {
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    if (char === "," && depth === 0) parts.push("");
    else parts[parts.length - 1] += char;
  }
  return parts;
}

/** What the text before the cursor, on its line, is about to complete. */
export type PythonCursor =
  | { kind: "member"; owner: string; prefix: string }
  | { kind: "keyword"; call: string; prefix: string; given: string[] }
  | { kind: "string"; context: string; prefix: string }
  | { kind: "comment" }
  | { kind: "code"; prefix: string };

export function pythonCursor(before: string): PythonCursor {
  let quote: string | null = null;
  let start = 0;
  for (let index = 0; index < before.length; index++) {
    const char = before[index];
    if (quote) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
      start = index;
    } else if (char === "#") return { kind: "comment" };
  }
  if (quote)
    return {
      kind: "string",
      context: before.slice(0, start).replace(/\b[rbfu]+$/i, ""),
      prefix: before.slice(start + 1),
    };
  const member = /((?:\w+\.)*\w+)\.(\w*)$/.exec(before);
  if (member) return { kind: "member", owner: member[1], prefix: member[2] };
  const call = callAround(before);
  const keyword = /(?:^|[(,])\s*(\w*)$/.exec(before.slice(call?.start ?? 0));
  if (call && keyword)
    return {
      kind: "keyword",
      call: call.name,
      prefix: keyword[1],
      given: call.given,
    };
  return { kind: "code", prefix: /\w*$/.exec(before)![0] };
}

/** The dotted name of the call around the end of a line, and the keywords given. */
function callAround(
  before: string,
): { name: string; start: number; given: string[] } | null {
  let depth = 0;
  for (let index = before.length - 1; index >= 0; index--) {
    const char = before[index];
    if (char === ")" || char === "]" || char === "}") depth++;
    else if (char === "(" || char === "[" || char === "{") {
      if (depth === 0) {
        if (char !== "(") return null;
        const name = /((?:\w+\.)*\w+)\s*$/.exec(before.slice(0, index));
        if (!name) return null;
        const given = [
          ...before.slice(index + 1).matchAll(/(?:^|,)\s*(\w+)\s*=(?!=)/g),
        ].map((match) => match[1]);
        return { name: name[1], start: index, given };
      }
      depth--;
    }
  }
  return null;
}

/** The context before a string literal asks for: an input, a binding, a level. */
export function stringPurpose(
  context: string,
  sdk: string | null,
):
  | "input"
  | "connection"
  | "schema"
  | "level"
  | "severity"
  | "name"
  | "column"
  | "expression" {
  if (/\binput\s*=\s*$/.test(context)) return "input";
  if (/\bconnection\s*=\s*$/.test(context)) return "connection";
  if (/\bschema\s*=\s*$/.test(context)) return "schema";
  if (/\bseverity\s*=\s*$/.test(context)) return "severity";
  if (/\bself\.message\(\s*$/.test(context)) return "level";
  // A new check, artifact or label names something; nothing to suggest.
  if (
    /\bself\.(?:check|artifact)\(\s*$/.test(context) ||
    /\b(?:label|description)\s*=\s*$/.test(context) ||
    (sdk && new RegExp(String.raw`\b${sdk}\.param\(\s*$`).test(context))
  )
    return "name";
  // These DuckDB methods accept SQL inside Python strings. Complete the
  // current identifier without replacing the expression before it.
  if (
    /\.(?:filter|project|select|order|aggregate|sql|query)\(\s*$/.test(context)
  )
    return "expression";
  return "column";
}
