import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchReleases, loadReleases } from "./releases.ts";
import { renderReleaseNotes } from "./release-markdown.ts";

const release = {
  tag_name: "v1.0.0",
  name: "Duckpad v1.0.0",
  published_at: "2026-10-20T12:00:00Z",
  prerelease: false,
  draft: false,
  body: "### Features\n\n- A new feature.",
};

test("paginates, excludes drafts and returns only published fields in date order", async () => {
  const requests: string[] = [];
  const request: typeof fetch = async (input, init) => {
    requests.push(String(input));
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      "Bearer test-token",
    );
    const body =
      requests.length === 1
        ? [...Array.from({ length: 99 }, () => ({ draft: true })), release]
        : [
            {
              ...release,
              tag_name: "v2.0.0-rc1",
              name: null,
              prerelease: true,
              published_at: "2026-10-21T12:00:00Z",
              body: null,
              author: { private: "ignored" },
            },
          ];
    return Response.json(body);
  };
  const results = await fetchReleases(request, "test-token");
  assert.equal(requests.length, 2);
  assert.match(requests[1], /per_page=100&page=2$/);
  assert.deepEqual(
    results.map((entry) => entry.tag),
    ["v2.0.0-rc1", "v1.0.0"],
  );
  assert.deepEqual(results[0], {
    tag: "v2.0.0-rc1",
    name: "v2.0.0-rc1",
    publishedAt: "2026-10-21T12:00:00Z",
    prerelease: true,
    body: "",
  });
});

test("rejects invalid responses and API failures without including credentials", async () => {
  for (const response of [
    new Response("rate limited", { status: 403 }),
    Response.json({ message: "invalid payload" }),
    Response.json([{ ...release, published_at: "not a date" }]),
  ]) {
    await assert.rejects(
      fetchReleases(async () => response, "test-token"),
      (error: Error) => {
        assert.doesNotMatch(error.message, /test-token/);
        return true;
      },
    );
  }
});

test("uses a bundled snapshot without credentials but fails authenticated publication", async () => {
  const unavailable: typeof fetch = async () =>
    new Response(null, { status: 404 });
  const fallback = await loadReleases(unavailable, "");
  assert.ok(fallback.length > 0);
  assert.ok(fallback.every((entry) => entry.tag && entry.body));
  await assert.rejects(loadReleases(unavailable, "test-token"), /HTTP 404/);
});

test("keeps an empty successful response instead of restoring removed releases", async () => {
  assert.deepEqual(await loadReleases(async () => Response.json([]), ""), []);
});

test("renders release Markdown without active HTML and scopes heading links per version", async () => {
  const html = await renderReleaseNotes(
    {
      tag: "v1.0.0",
      name: "Duckpad v1.0.0",
      publishedAt: release.published_at,
      prerelease: false,
      body: "## Duckpad v1.0.0\n\n## Features\n\n**Useful change** and [details](#features).\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[unsafe](javascript:alert(1))",
    },
    "release-v1.0.0",
  );
  assert.match(html, /<strong>Useful change<\/strong>/);
  assert.match(html, /<h3 id="release-v1.0.0-features">/);
  assert.match(html, /href="#release-v1.0.0-features"/);
  assert.doesNotMatch(html, /<script|onerror|javascript:|<h2|Duckpad v1.0.0/);
});
