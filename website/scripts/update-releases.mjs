import { writeFile } from "node:fs/promises";
import { fetchReleases } from "../src/lib/releases.ts";

const releases = await fetchReleases();
await writeFile(
  new URL("../src/data/releases.json", import.meta.url),
  `${JSON.stringify(releases, null, 2)}\n`,
);
console.log(
  `Updated the release snapshot (${releases.length} published releases).`,
);
