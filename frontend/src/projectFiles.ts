export function projectFileLanguage(path: string): string {
  if (path.endsWith(".sql")) return "sql";
  if (path.endsWith(".md")) return "markdown";
  // Monaco's INI tokenizer covers TOML sections, keys, strings and comments.
  if (path.endsWith(".toml")) return "ini";
  return "json";
}
