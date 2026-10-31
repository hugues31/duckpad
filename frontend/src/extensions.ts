export type ExtensionSource = "core" | "community" | "unsigned";
export interface ProjectExtension {
  source: ExtensionSource;
  enabled: boolean;
}

/** An extension that DuckDB lists, from the server's build or its website. */
export interface CatalogEntry {
  name: string;
  source: "core" | "community";
  description: string;
  aliases: string[];
  built_in: boolean;
}
/** Core extensions as the server's DuckDB build lists them, offline. */
export type CoreExtension = Omit<CatalogEntry, "source">;

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** DuckDB's official lists, to browse in a new tab. */
export const extensionLists = {
  core: "https://duckdb.org/docs/stable/core_extensions/overview",
  community: "https://duckdb.org/community_extensions/list_of_extensions",
};

export function extensionDownload(
  runtime: { version: string; platform: string },
  name: string,
  source: ExtensionSource,
) {
  if (source === "unsigned" || !NAME.test(name)) return null;
  const host =
    source === "community"
      ? "community-extensions.duckdb.org"
      : "extensions.duckdb.org";
  return `https://${host}/${runtime.version}/${runtime.platform}/${name}.duckdb_extension.gz`;
}

export const extensionSourceKey = (source: ExtensionSource) =>
  source === "core"
    ? "extensionCore"
    : source === "community"
      ? "extensionCommunity"
      : "extensionUnsigned";

// Requests from the browser carry neither cookies nor the Duckpad address.
const anonymous = {
  credentials: "omit",
  referrerPolicy: "no-referrer",
} satisfies RequestInit;

/** Read the name and description columns of DuckDB's community list page. */
export function parseCommunityList(html: string): CatalogEntry[] {
  const page = new DOMParser().parseFromString(html, "text/html");
  const entries = new Map<string, CatalogEntry>();
  for (const row of page.querySelectorAll("table tbody tr")) {
    const cells = row.querySelectorAll("td");
    const name = cells[0]?.textContent?.trim() || "";
    if (NAME.test(name) && !entries.has(name))
      entries.set(name, {
        name,
        source: "community",
        description: cells[2]?.textContent?.trim() || "",
        aliases: [],
        built_in: false,
      });
  }
  if (!entries.size) throw new Error("The community list has no extensions");
  return [...entries.values()];
}

let community: Promise<CatalogEntry[]> | null = null;

/**
 * Load the community list in the browser, once per page load. The server never
 * contacts it: an offline browser rejects, and the exact name is entered instead.
 */
export function communityExtensions() {
  community ??= fetch(extensionLists.community, {
    ...anonymous,
    signal: AbortSignal.timeout(15_000),
  })
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    })
    .then(parseCommunityList)
    .catch((error: unknown) => {
      community = null;
      throw error;
    });
  return community;
}

/**
 * Whether DuckDB publishes a download: false when its repository answers that
 * the file does not exist, null when the browser cannot tell.
 */
export async function publishedDownload(url: string, signal: AbortSignal) {
  try {
    const response = await fetch(url, { ...anonymous, method: "HEAD", signal });
    if (response.ok) return true;
    return response.status === 403 || response.status === 404 ? false : null;
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

/** Entries matching a typed name: exact names first, then prefixes, then mentions. */
export function searchCatalog(entries: CatalogEntry[], query: string) {
  const text = query.trim().toLowerCase();
  if (!text) return entries;
  const rank = (entry: CatalogEntry) => {
    const names = [entry.name, ...entry.aliases];
    if (names.includes(text)) return 0;
    if (names.some((name) => name.startsWith(text))) return 1;
    if (names.some((name) => name.includes(text))) return 2;
    return entry.description.toLowerCase().includes(text) ? 3 : -1;
  };
  return entries
    .map((entry) => ({ entry, rank: rank(entry) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map(({ entry }) => entry);
}
