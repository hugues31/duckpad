import snapshot from "../data/releases.json" with { type: "json" };

export const releasesURL = "https://github.com/hugues31/duckpad/releases";
const endpoint = "https://api.github.com/repos/hugues31/duckpad/releases";

export interface Release {
  tag: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  body: string;
}

export const releaseURL = (release: Release) =>
  `${releasesURL}/tag/${encodeURIComponent(release.tag)}`;

export async function fetchReleases(
  request: typeof fetch = fetch,
  token = process.env.GITHUB_TOKEN,
): Promise<Release[]> {
  const releases: Release[] = [];
  for (let page = 1; ; page++) {
    const response = await request(`${endpoint}?per_page=100&page=${page}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error(`Release retrieval failed (HTTP ${response.status}).`);
    const entries: unknown = await response.json();
    if (!Array.isArray(entries)) throw new Error("Invalid release response.");
    for (const entry of entries) {
      if (!entry || typeof entry !== "object")
        throw new Error("Invalid release entry.");
      if (entry.draft === true) continue;
      if (
        entry.draft !== false ||
        typeof entry.tag_name !== "string" ||
        !entry.tag_name ||
        typeof entry.published_at !== "string" ||
        !Number.isFinite(Date.parse(entry.published_at)) ||
        typeof entry.prerelease !== "boolean" ||
        (entry.body != null && typeof entry.body !== "string")
      )
        throw new Error("Invalid published release.");
      releases.push({
        tag: entry.tag_name,
        name:
          typeof entry.name === "string" && entry.name
            ? entry.name
            : entry.tag_name,
        publishedAt: entry.published_at,
        prerelease: entry.prerelease,
        body: entry.body ?? "",
      });
    }
    if (entries.length < 100) break;
  }
  return releases.sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
}

export async function loadReleases(
  request: typeof fetch = fetch,
  token = process.env.GITHUB_TOKEN,
): Promise<Release[]> {
  try {
    return await fetchReleases(request, token);
  } catch (error) {
    // Authenticated publication must not silently publish stale release notes.
    if (token) throw error;
    console.warn(
      "Release notes: using the bundled snapshot; GitHub is unavailable.",
    );
    return snapshot;
  }
}

let feed: Promise<Release[]> | undefined;
export const getReleases = () => (feed ??= loadReleases());
