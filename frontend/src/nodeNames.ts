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
