import { templateLabel, type Translate } from "./i18n";

/** Resolved on the server by node_names; explicit user labels are never translated. */
export type NodeName = { label: string; template?: string }[];
export type NodeNames = Record<string, NodeName>;

export function displayNodeName(
  name: NodeName | undefined,
  fallback: string,
  t: Translate,
) {
  return name?.length
    ? name
        .map((part) =>
          part.template
            ? templateLabel(part.template, part.label, t)
            : part.label,
        )
        .join(" / ")
    : fallback;
}

/** Readable node and field titles; the original path remains the conflict identity. */
export function nodeConflictLabel(
  path: string,
  names: NodeNames,
  t: Translate,
) {
  const field =
    /^(flow\.json|components\/([^/]+)\.json)\/nodes\/([^/]+)(?:\/(.*))?$/.exec(
      path,
    );
  const code = /^(nodes\/([^/]+)|components\/[^/]+\/[^/]+)\.sql$/.exec(path);
  const key = field
    ? field[2]
      ? `components/${field[2]}/${field[3]}`
      : field[3]
    : code
      ? code[2] || code[1]
      : undefined;
  if (!key || !names[key]) return null;
  const detail = field?.[4]?.replace(/^params\//, "").replaceAll("/", " · ");
  return `${displayNodeName(names[key], key, t)}${code ? " · SQL" : detail ? ` · ${detail}` : ""}`;
}
