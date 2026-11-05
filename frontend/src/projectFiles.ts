import { displayNodeName, type NodeNames } from "./nodeNames";
import type { Translate } from "./i18n";
import { nodeLocation, nodeSourcePath } from "./nodeCode";
import type { Snapshot } from "./types";

export function projectFileLanguage(path: string): string {
  if (path.endsWith(".py")) return "python";
  if (path === "uv.lock") return "ini";
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".md")) return "markdown";
  // Monaco's INI tokenizer covers TOML sections, keys, strings and comments.
  if (path.endsWith(".toml")) return "ini";
  return "json";
}
export function initialProjectFile(snapshot: Snapshot, selectedNode: string) {
  const location =
    snapshot.bundle &&
    selectedNode &&
    nodeLocation(snapshot.bundle, selectedNode);
  const source = location && nodeSourcePath(location.node, location.parent);
  if (source && source in snapshot.files) return source;
  return "README.md" in snapshot.files
    ? "README.md"
    : Object.keys(snapshot.files).sort()[0] || "";
}

/** File identities stay stable while the tree shows the authored node captions. */
export function projectFileLabel(path: string, names: NodeNames, t: Translate) {
  const node = path.match(/^(nodes\/|components\/[^/]+\/)([^/]+)\.(sql|py)$/);
  if (!node) return path.split("/").at(-1)!;
  const key = node[1] === "nodes/" ? node[2] : node[1] + node[2];
  return displayNodeName(names[key], t("node"), t);
}
