export function projectFileLanguage(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path === "uv.lock") return "ini";
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".md")) return "markdown";
  // Monaco's INI tokenizer covers TOML sections, keys, strings and comments.
  if (path.endsWith(".toml")) return "ini";
  return "json";
}
import { displayNodeName, type NodeNames } from "./nodeNames";
import type { Translate } from "./i18n";

/** File identities stay stable while the tree shows the authored node captions. */
export function projectFileLabel(path: string, names: NodeNames, t: Translate) {
  const node = path.match(/^(nodes\/|components\/[^/]+\/)([^/]+)\.(sql|py)$/);
  if (!node) return path.split("/").at(-1)!;
  const key = node[1] === "nodes/" ? node[2] : node[1] + node[2];
  return displayNodeName(names[key], t("node"), t);
}
