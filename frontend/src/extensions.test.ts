// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  communityExtensions,
  parseCommunityList,
  publishedDownload,
  searchCatalog,
  type CatalogEntry,
} from "./extensions";

const page = `<table><thead><tr><th>Name</th><th>GitHub</th><th>Description</th></tr></thead>
<tbody>
  <tr><td><a href="/h3.html">h3</a></td><td><a>GitHub</a></td><td> Hierarchical hexagonal indexing </td></tr>
  <tr><td><a>Not A Name</a></td><td></td><td>Ignored</td></tr>
  <tr><td><a>h3</a></td><td></td><td>Duplicate</td></tr>
  <tr><td><a>gsheets</a></td><td></td><td>Read and write Google Sheets</td></tr>
</tbody></table>`;

const entry = (
  name: string,
  description = "",
  aliases: string[] = [],
): CatalogEntry => ({
  name,
  source: "core",
  description,
  aliases,
  built_in: false,
});

describe("extension catalog", () => {
  it("reads valid names and descriptions from the community list page", () => {
    expect(parseCommunityList(page)).toEqual([
      {
        name: "h3",
        source: "community",
        description: "Hierarchical hexagonal indexing",
        aliases: [],
        built_in: false,
      },
      {
        name: "gsheets",
        source: "community",
        description: "Read and write Google Sheets",
        aliases: [],
        built_in: false,
      },
    ]);
    // A page without the expected table counts as unavailable.
    expect(() => parseCommunityList("<p>Moved</p>")).toThrow();
  });

  it("ranks exact names and aliases, then prefixes, names and descriptions", () => {
    const entries = [
      entry("spatial", "Geospatial extension"),
      entry("postgres_scanner", "Connect to a Postgres database", ["postgres"]),
      entry("h3", "Hexagonal geo indexing"),
      entry("geo"),
      entry("geography"),
    ];
    expect(searchCatalog(entries, "").map((e) => e.name)).toEqual(
      entries.map((e) => e.name),
    );
    expect(searchCatalog(entries, "geo").map((e) => e.name)).toEqual([
      "geo",
      "geography",
      "spatial",
      "h3",
    ]);
    expect(searchCatalog(entries, "postgres").map((e) => e.name)).toEqual([
      "postgres_scanner",
    ]);
    expect(searchCatalog(entries, "scanner").map((e) => e.name)).toEqual([
      "postgres_scanner",
    ]);
    expect(searchCatalog(entries, "oracle")).toEqual([]);
  });

  it("loads the community list anonymously and retries after a failure", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(new Response(page));
    vi.stubGlobal("fetch", fetch);
    await expect(communityExtensions()).rejects.toThrow("Failed to fetch");
    expect((await communityExtensions()).map((e) => e.name)).toEqual([
      "h3",
      "gsheets",
    ]);
    // A successful list is kept for the rest of the page's life.
    await communityExtensions();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  });

  it("tells published, missing and unknown downloads apart", async () => {
    const signal = new AbortController().signal;
    const answer = (response: Response | Error) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          response instanceof Error
            ? Promise.reject(response)
            : Promise.resolve(response),
        ),
      );
    answer(new Response(null, { status: 200 }));
    expect(await publishedDownload("https://example.test/a", signal)).toBe(
      true,
    );
    answer(new Response(null, { status: 404 }));
    expect(await publishedDownload("https://example.test/a", signal)).toBe(
      false,
    );
    answer(new Response(null, { status: 503 }));
    expect(await publishedDownload("https://example.test/a", signal)).toBe(
      null,
    );
    // Offline browsers and blocked requests leave the question open.
    answer(new TypeError("Failed to fetch"));
    expect(await publishedDownload("https://example.test/a", signal)).toBe(
      null,
    );
  });
});
