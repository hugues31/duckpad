/**
 * Check the UI translation catalogs in src/locales against the frontend sources,
 * excluding unit tests (*.test.ts and *.test.tsx):
 *
 * - every locale defines the same keys, each exactly once;
 * - every key passed to t() as a string literal, including each branch of a
 *   condition or fallback, exists in every locale;
 * - every key is used: written as a string literal in the sources or listed in
 *   DYNAMIC_KEYS.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Keys that the frontend only builds from runtime values, so they never appear
 * as string literals in its sources. Values that the sources also name
 * literally, such as most run statuses, need no entry.
 */
const DYNAMIC_KEYS = [
  // Run, node and export states reported by the engine.
  "pending",
  "interrupted",
  "completed",
  "unknown",
  "partial or unknown",
  // Worktree states reported by the Git workspace.
  "clean",
  "closed",
  // Built-in template labels, translated by templateLabel().
  "load_csv",
  "load_parquet",
  "load_xlsx",
  "load_oracle",
  "export_csv",
  "export_xlsx",
  "export_oracle",
  // Roles: role_<role> and project_<role>_hint.
  "role_editor",
  "role_reader",
  "role_operator",
  "project_reader_hint",
  "project_operator_hint",
  "project_editor_hint",
  "project_admin_hint",
  // Remote branch states: sync_<state> and recovery_<state>.
  "sync_disconnected",
  "sync_unverified",
  "sync_up_to_date",
  "sync_ahead",
  "sync_behind",
  "sync_diverged",
  "sync_new_remote_branch",
  "sync_remote_deleted",
  "sync_unrelated",
  "recovery_behind",
  "recovery_diverged",
  "recovery_unrelated",
  "recovery_unverified",
  "recovery_remote_deleted",
  // Lineage calculation explanations: <operation>Reason.
  "lineageSumReason",
  "lineageAverageReason",
  "lineageMinimumReason",
  "lineageMaximumReason",
  "lineageCountReason",
  "lineageDistinctCountReason",
];

const frontend = fileURLToPath(new URL("..", import.meta.url));
const sourceDir = join(frontend, "src");
const localeDir = join(sourceDir, "locales");
const errors = [];

function report(file, node, message) {
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
  errors.push(`${relative(frontend, file.fileName)}:${line + 1}: ${message}`);
}

/** Read a locale's key declarations; JSON.parse would silently drop duplicates. */
function readLocale(name) {
  const path = join(localeDir, name);
  const text = readFileSync(path, "utf8");
  JSON.parse(text);
  const file = ts.parseJsonText(path, text);
  const keys = new Map();
  for (const property of file.statements[0].expression.properties) {
    const key = property.name.text;
    if (keys.has(key)) report(file, property, `"${key}" is defined twice`);
    else keys.set(key, property);
  }
  return { name, file, keys };
}

/** String literals that a t() argument can evaluate to, through conditions and fallbacks. */
function literalKeys(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return [node];
  if (ts.isParenthesizedExpression(node)) return literalKeys(node.expression);
  if (ts.isConditionalExpression(node))
    return [...literalKeys(node.whenTrue), ...literalKeys(node.whenFalse)];
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
  )
    return [...literalKeys(node.left), ...literalKeys(node.right)];
  return [];
}

const locales = readdirSync(localeDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map(readLocale);
const defined = new Map();
for (const locale of locales)
  for (const [key, property] of locale.keys) {
    if (!defined.has(key)) defined.set(key, { file: locale.file, property });
    for (const other of locales)
      if (!other.keys.has(key))
        report(locale.file, property, `"${key}" is missing from ${other.name}`);
  }

const used = new Set(DYNAMIC_KEYS);
for (const name of readdirSync(sourceDir, { recursive: true })) {
  // Unit tests are not application code: their string literals must not count
  // as uses of a key, which would hide keys the application no longer uses.
  if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
  const path = join(sourceDir, name);
  const file = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      used.add(node.text);
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "t" &&
      node.arguments.length
    )
      for (const literal of literalKeys(node.arguments[0])) {
        const missing = locales.filter((l) => !l.keys.has(literal.text));
        if (missing.length)
          report(
            file,
            literal,
            `t("${literal.text}") is missing from ${missing.map((l) => l.name).join(", ")}`,
          );
      }
    ts.forEachChild(node, visit);
  };
  visit(file);
}

for (const key of DYNAMIC_KEYS)
  if (!defined.has(key))
    errors.push(
      `scripts/check-i18n.mjs: DYNAMIC_KEYS lists "${key}", which no locale defines`,
    );
for (const [key, { file, property }] of defined)
  if (!used.has(key))
    report(
      file,
      property,
      `"${key}" is never used; remove it from every locale, or add it to DYNAMIC_KEYS in scripts/check-i18n.mjs if the frontend only builds it at runtime`,
    );

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(
  `${defined.size} translation keys are consistent across ${locales.map((l) => l.name).join(", ")}.`,
);
