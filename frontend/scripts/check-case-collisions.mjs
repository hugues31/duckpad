import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const moduleExtension = /\.(?:d\.)?[cm]?[jt]sx?$/;

/**
 * Group paths that macOS and Windows treat as one file. Imports omit module
 * extensions, so `Panel.tsx` and `panel.ts` collide too. CI runs on Linux,
 * where both resolve, so only this check catches them.
 */
export function caseCollisions(paths) {
  const groups = new Map();
  for (const path of paths) {
    const name = path.replace(moduleExtension, "");
    const key = name.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), [name, path]]);
  }
  return [...groups.values()]
    .filter((group) => new Set(group.map(([name]) => name)).size > 1)
    .map((group) => group.map(([, path]) => path).sort());
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [relative(process.cwd(), path)];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const collisions = caseCollisions(
    ["src", "e2e", "docs", "scripts"].flatMap((directory) =>
      files(fileURLToPath(new URL(`../${directory}`, import.meta.url))),
    ),
  );
  for (const paths of collisions)
    console.error(
      `${paths.join(", ")}: names differ only in case, which breaks imports on macOS and Windows`,
    );
  if (collisions.length) process.exitCode = 1;
}
