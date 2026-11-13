/**
 * Read and write the `@icon` and `@color` directives of a node's code: `--`
 * comments in SQL, `#` comments in Python.
 */
import { appearanceName } from "./nodeIcons";
import {
  APPEARANCE_KEYS,
  knownAppearance,
  type Appearance,
  type AppearanceKey,
} from "./nodeAppearance";
import { readDirective, type TemplateProblem } from "./sqlTemplate";

const PYTHON_COMMENT = /^# @(label|icon|color) (.*)$/;

interface DescriptiveLine {
  key: string;
  value: string;
  /** 1-based column of the key and of the value. */
  keyColumn: number;
  valueColumn: number;
}

/**
 * `# @icon filter` on a line of Python, or null. The server reads the same
 * comments in `python_contract.py`.
 */
export function readPythonDirective(line: string): DescriptiveLine | null {
  const match = PYTHON_COMMENT.exec(line.trim());
  if (!match) return null;
  const [, key, rest] = match;
  const keyColumn = line.indexOf("@" + key) + 2;
  return {
    key,
    value: rest.trim(),
    keyColumn,
    // After the key and the space that follows it.
    valueColumn:
      keyColumn + key.length + 1 + (rest.length - rest.trimStart().length),
  };
}

/** The directive on a line of a node's code, in the comments of its language. */
export const readDescriptive = (
  line: string,
  language: string | undefined,
): DescriptiveLine | null =>
  language === "python" ? readPythonDirective(line) : readDirective(line);

// A new directive goes after the last of those that precede it here.
const HEADER = ["label", "description", "icon", "color"];

/**
 * A node's code with a change to its appearance: a name is written on its
 * directive, added under the label when the code has none, and an undefined
 * name removes the directive. What the change does not mention stays as it is
 * written, even a name Duckpad cannot show.
 */
export function withAppearance(
  code: string,
  language: string | undefined,
  change: Appearance,
) {
  // Lines keep their own endings, which the server reads the same way.
  const parts = code.split(/(\r\n|\r|\n)/);
  const lines: { text: string; end: string }[] = [];
  for (let index = 0; index < parts.length; index += 2)
    lines.push({ text: parts[index], end: parts[index + 1] ?? "" });
  const newline = lines.find((line) => line.end)?.end ?? "\n";
  const keyOf = (line: { text: string }) =>
    readDescriptive(line.text, language)?.key;
  const remove = (index: number) => {
    // The code ends as it did, with or without a last line break.
    if (index === lines.length - 1 && index > 0)
      lines[index - 1].end = lines[index].end;
    lines.splice(index, 1);
  };
  const comment = language === "python" ? "#" : "--";
  for (const key of APPEARANCE_KEYS) {
    if (!Object.hasOwn(change, key)) continue;
    const name = appearanceName(change[key]);
    const text = `${comment} @${key} ${name}`;
    const declared = lines.flatMap((line, index) =>
      keyOf(line) === key ? [index] : [],
    );
    if (declared.length) {
      // One directive remains, so SQL and Python agree on the name in effect.
      for (const index of declared.slice(1).reverse()) remove(index);
      if (name) lines[declared[0]].text = text;
      else remove(declared[0]);
    } else if (name) {
      const earlier = HEADER.slice(0, HEADER.indexOf(key));
      let after = lines[0].text.startsWith("#!") ? 0 : -1;
      lines.forEach((line, index) => {
        if (earlier.includes(keyOf(line) ?? "")) after = index;
      });
      const previous = lines[after];
      if (previous && !previous.end) {
        previous.end = newline;
        lines.splice(after + 1, 0, { text, end: "" });
      } else lines.splice(after + 1, 0, { text, end: newline });
    }
  }
  return lines.map((line) => line.text + line.end).join("");
}

/** What a Python comment before the cursor is about to complete, if a directive. */
export type PythonDirectiveCursor =
  | { kind: "directive"; prefix: string }
  | { kind: "appearance"; key: AppearanceKey; prefix: string };

export const PYTHON_DIRECTIVES = ["label", "icon", "color"] as const;

export function pythonDirectiveCursor(
  before: string,
): PythonDirectiveCursor | null {
  const directive = /^\s*# @(\w*)$/.exec(before);
  if (directive) return { kind: "directive", prefix: directive[1] };
  const appearance = /^\s*# @(icon|color) +(.*)$/.exec(before);
  return appearance
    ? {
        kind: "appearance",
        key: appearance[1] as AppearanceKey,
        prefix: appearance[2],
      }
    : null;
}

/**
 * The icon and color names of Python code that Duckpad cannot show. SQL
 * templates report theirs with their other problems, in `lintTemplate`.
 */
export function lintPythonAppearance(text: string): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  // Like the server, only the first directive of each kind counts.
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((line, index) => {
    const found = readPythonDirective(line);
    if (!found || seen.has(found.key)) return;
    seen.add(found.key);
    if (found.key !== "icon" && found.key !== "color") return;
    if (found.value && !knownAppearance(found.key, found.value))
      problems.push({
        code: found.key === "icon" ? "unknownIcon" : "unknownColor",
        subject: found.value,
        severity: "warning",
        line: index + 1,
        column: found.valueColumn,
        endColumn: found.valueColumn + found.value.length,
      });
  });
  return problems;
}
