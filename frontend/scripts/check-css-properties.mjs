import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

/** Include inline styles, since graph edges use the same tokens as stylesheets. */
export function undefinedProperties(sources) {
  const definitions = new Set();
  const references = [];
  for (const [file, source] of sources) {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of text.matchAll(/(--[\w-]+)["']?\s*:/g))
      definitions.add(match[1]);
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g))
      references.push([file, match[1]]);
  }
  return references.filter(([, property]) => !definitions.has(property));
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(css|tsx?)$/.test(entry.name) && !entry.name.includes(".test.")
      ? [[relative(process.cwd(), path), readFileSync(path, "utf8")]]
      : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = undefinedProperties(
    sources(fileURLToPath(new URL("../src", import.meta.url))),
  );
  for (const [file, property] of missing)
    console.error(`${file}: undefined CSS custom property ${property}`);
  if (missing.length) process.exitCode = 1;
}
