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
  const { html } = await renderReleaseNotes(
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

test("structures generated notes into groups, scopes, links and migration notes", async () => {
  const commit = (sha: string) =>
    `([${sha.slice(0, 7)}](https://github.com/hugues31/duckpad/commit/${sha}))`;
  const notes = await renderReleaseNotes(
    {
      tag: "v1.1.0",
      name: "Duckpad v1.1.0",
      publishedAt: release.published_at,
      prerelease: false,
      body: [
        "## Duckpad v1.1.0",
        "",
        "````sh",
        "pip install duckpad==1.1.0",
        "````",
        "",
        "### Breaking changes",
        "",
        `- **cli:** Rename the home option (#12) ${commit("a".repeat(40))}`,
        "",
        " > ",
        " > Pass --home <directory> instead.",
        "",
        "### Features",
        "",
        `- **flow:** Add \`muted\` nodes (#13) ${commit("b".repeat(40))}`,
        "",
        `- Speed up start-up ${commit("c".repeat(40))}`,
        "",
        "### Maintenance",
        "",
        `- **deps:** Bump a dependency ${commit("d".repeat(40))}`,
        "",
        "**Full changelog:** [v1.0.0...v1.1.0](https://github.com/hugues31/duckpad/compare/v1.0.0...v1.1.0)",
        "",
        "The wheel includes the web interface; Node.js is not required. Download the wheel,",
        "source archive, and SHA-256 checksums from the assets below.",
      ].join("\n"),
    },
    "release-v1.1.0",
  );
  assert.equal(notes.install, "pip install duckpad==1.1.0");
  assert.deepEqual(notes.compare, {
    href: "https://github.com/hugues31/duckpad/compare/v1.0.0...v1.1.0",
    label: "v1.0.0...v1.1.0",
  });
  assert.deepEqual(
    notes.groups.map(({ kind, count }) => [kind, count]),
    [
      ["breaking-changes", 1],
      ["features", 2],
      ["maintenance", 1],
    ],
  );
  const { html } = notes;
  assert.match(html, /<section class="release-group" data-kind="features">/);
  assert.match(
    html,
    /<details class="release-group" data-kind="maintenance"><summary class="release-group-summary"><h3/,
  );
  assert.match(
    html,
    /<span class="release-scope">flow<\/span> Add <code>muted<\/code> nodes/,
  );
  assert.match(
    html,
    /<a class="release-pr" href="https:\/\/github.com\/hugues31\/duckpad\/pull\/13" aria-label="Pull request #13">#13<\/a>/,
  );
  assert.match(html, /<a href="[^"]+\/commit\/b{40}" class="release-commit"/);
  assert.doesNotMatch(
    html,
    /\(<a|<\/a>\)|pip install|Full changelog|The wheel/,
  );
  // The migration note belongs to its breaking change, with options intact.
  assert.match(
    html,
    /Rename the home option[\s\S]*<blockquote class="release-note">[\s\S]*--home[\s\S]*<\/blockquote>\s*<\/li>/,
  );
  assert.match(html, /<span class="release-count">2<\/span>/);
});
