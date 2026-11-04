import type { ConflictValue, EntityChange, MergeConflict } from "./gitTypes";
import { templateLabel, type Translate } from "./i18n";
import type { Conflict, Json } from "./types";
import type { NodeNames } from "./nodeNames";
import { conflictLabel } from "./variables";

/** File name followed by the semantic JSON pointer used by the merge engine. */
export function conflictPath(path: string) {
  const [, file = path, pointer = ""] =
    path.match(/^(.*?\.(?:json|sql|md|toml))(\/.*)?$/) || [];
  return {
    file,
    parts: pointer
      ? pointer
          .slice(1)
          .split("/")
          .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
      : [],
  };
}

const object = (value: Json | undefined): Record<string, Json> =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

function definition(files: Record<string, string>, file: string) {
  try {
    return object(JSON.parse(files[file]));
  } catch {
    return {};
  }
}

/** Prefer a user label, then the SQL/component label, then the stable identifier. */
export function conflictTitle(
  path: string,
  t: Translate,
  versions: Record<string, string>[] = [],
  entities: EntityChange[] = [],
  names: NodeNames = {},
) {
  const resolved = conflictLabel(path, t, names);
  if (resolved) return resolved;
  const { file, parts } = conflictPath(path);
  const sql = file.match(/^(?:nodes\/|components\/([^/]+)\/)([^/]+)\.sql$/);
  const component = file.match(/^components\/([^/]+)\.json$/)?.[1] || sql?.[1];
  const graphFile = sql
    ? component
      ? `components/${component}.json`
      : "flow.json"
    : file;
  const node = sql?.[2] || (parts[0] === "nodes" ? parts[1] : undefined);
  const field = file.endsWith(".sql")
    ? t("sql")
    : parts
        .slice(node ? 2 : 0)
        .filter((part) => part !== "params")
        .join(" · ");
  const entity = entities.find((item) =>
    node
      ? item.kind === "node" &&
        item.id === `${component ? `component/${component}/` : ""}node/${node}`
      : item.file === file &&
        (item.kind === "component" || item.kind === "template"),
  );
  let name = entity?.name;
  for (const files of versions) {
    if (name) break;
    const graph = definition(files, graphFile);
    const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const found = object(nodes.find((item) => object(item).id === node));
    const code =
      files[file.endsWith(".sql") ? file : `nodes/${node}.sql`] ||
      files[`${component ? `components/${component}` : "nodes"}/${node}.sql`] ||
      files[`templates/${found.template}.sql`];
    const label = code?.match(/^\s*--\s*@label\s+(.+)$/m)?.[1]?.trim();
    const componentName =
      typeof found.component === "string"
        ? definition(files, `components/${found.component}.json`).name
        : undefined;
    if (node) {
      name =
        typeof found.label === "string" && found.label
          ? found.label
          : typeof componentName === "string"
            ? componentName
            : label
              ? templateLabel(
                  String(
                    found.preset || found.template || found.origin || "sql",
                  ),
                  label,
                  t,
                )
              : undefined;
    } else {
      name = label || (typeof graph.name === "string" ? graph.name : undefined);
    }
  }
  name ||=
    node ||
    component ||
    (file === "flow.json" ? t("flow") : file.split("/").at(-1)!);
  return `${name}${field ? ` · ${field}` : ""}`;
}

export const valueText = (value: ConflictValue) =>
  !value.present
    ? ""
    : typeof value.value === "string"
      ? value.value
      : JSON.stringify(value.value, null, 2);

export interface ConflictDraft {
  text: string;
  present: boolean;
}
export const conflictDrafts = (
  conflict: Conflict,
): Record<string, ConflictDraft> =>
  Object.fromEntries(
    conflict.fields.map((field) => [
      field.path,
      {
        text: valueText(field.incoming),
        present: field.incoming.present,
      },
    ]),
  );

/** Apply only edited conflict values to the server's three-way merge. */
export function combinedFiles(
  conflict: Conflict,
  drafts: Record<string, ConflictDraft>,
) {
  const files = { ...conflict.merged };
  for (const field of conflict.fields) {
    const { file, parts } = conflictPath(field.path);
    const draft = drafts[field.path];
    if (!parts.length) {
      if (draft.present) files[file] = draft.text;
      else delete files[file];
      continue;
    }
    const source = field.incoming.present ? field.incoming : field.current;
    const value: Json =
      typeof source.value === "string"
        ? draft.text
        : draft.present
          ? JSON.parse(draft.text)
          : null;
    const root: Json = JSON.parse(files[file]);
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      const next = Array.isArray(parent)
        ? parent.find(
            (item) =>
              object(item)[file === "views.json" ? "name" : "id"] === part,
          )
        : object(parent)[part];
      if (!next || typeof next !== "object")
        throw new Error(`Cannot edit ${field.path}`);
      parent = next;
    }
    const key = parts.at(-1)!;
    if (Array.isArray(parent)) {
      const index = parent.findIndex(
        (item) => object(item)[file === "views.json" ? "name" : "id"] === key,
      );
      if (draft.present) {
        if (index < 0) parent.push(value);
        else parent[index] = value;
      } else if (index >= 0) parent.splice(index, 1);
    } else if (parent && typeof parent === "object") {
      if (draft.present) parent[key] = value;
      else delete parent[key];
    }
    files[file] = JSON.stringify(root, null, 2) + "\n";
  }
  return files;
}

/** Changed character positions, with bounded work for very large field values. */
export function changedCharacters(
  before: string,
  after: string,
): [Set<number>, Set<number>] {
  const removed = new Set<number>(),
    added = new Set<number>();
  let start = 0;
  while (start < before.length && before[start] === after[start]) start++;
  let endA = before.length,
    endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA--;
    endB--;
  }
  const a = before.slice(start, endA),
    b = after.slice(start, endB);
  if (a.length * b.length > 1_000_000) {
    for (let i = start; i < endA; i++) removed.add(i);
    for (let i = start; i < endB; i++) added.add(i);
    return [removed, added];
  }
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lengths[i * width + j] =
        a[i] === b[j]
          ? 1 + lengths[(i + 1) * width + j + 1]
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (
      i < a.length &&
      (j === b.length ||
        lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])
    )
      removed.add(start + i++);
    else added.add(start + j++);
  }
  return [removed, added];
}

export function conflictCounts(conflicts: Pick<MergeConflict, "path">[]) {
  return conflicts.reduce(
    (counts, item) => {
      counts[conflictPath(item.path).parts.length ? "fields" : "files"]++;
      return counts;
    },
    { files: 0, fields: 0 },
  );
}
