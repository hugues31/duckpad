import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

test("homepage, captions and recorded media are available", async ({
  page,
}, testInfo) => {
  // Full-page captures resize the viewport; suppress native navigation transitions.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "See the flow.Trust the result.",
  );
  await page.screenshot({
    path: testInfo.outputPath("website-home.png"),
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  const video = page.locator("video");
  const caption = video.locator("track");
  expect(
    await (await page.request.get((await caption.getAttribute("src"))!)).text(),
  ).toContain("WEBVTT");
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.videoWidth),
    )
    .toBe(1440);
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await page.getByRole("link", { name: "Build your first pipeline" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Your first pipeline",
  );
  await page.screenshot({
    path: testInfo.outputPath("website-docs.png"),
    fullPage: true,
  });
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  expect(errors).toEqual([]);
});

test("all documentation routes, internal links, fragments and images resolve", async ({
  page,
  baseURL,
}) => {
  const index = await (
    await page.request.get(new URL("search.json", baseURL).href)
  ).json();
  expect(index.length).toBeGreaterThanOrEqual(11);
  const checked = new Set<string>();
  for (const entry of index) {
    const response = await page.goto(entry.url);
    expect(response?.status(), entry.url).toBe(200);
    await expect(page.locator("h1")).toHaveCount(1);
    const images = await page.locator("img").evaluateAll((elements) =>
      elements.map((image) => ({
        src: image.src,
        loaded: image.complete && image.naturalWidth > 0,
      })),
    );
    for (const image of images) expect(image.loaded, image.src).toBeTruthy();
    const links = await page
      .locator("a[href]")
      .evaluateAll((elements) =>
        elements.map((a) => (a as HTMLAnchorElement).href),
      );
    for (const link of links) {
      const target = new URL(link);
      if (target.origin !== new URL(baseURL!).origin || checked.has(link))
        continue;
      checked.add(link);
      const result = await page.request.get(link);
      expect(result.status(), link).toBe(200);
      if (target.hash)
        expect(await result.text(), link).toContain(
          `id="${decodeURIComponent(target.hash.slice(1))}"`,
        );
    }
  }
});

test("search uses guide content, handles no results and supports the keyboard", async ({
  page,
}) => {
  await page.goto("docs/quickstart/");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog")).toBeVisible();
  const input = page.getByRole("searchbox", { name: "Search documentation" });
  await expect(input).toBeFocused();
  await input.fill("Landlock");
  await expect(page.locator(".search-results")).toContainText("Architecture");
  await input.fill("no-such-guide-123");
  await expect(page.getByRole("status")).toContainText("No guides found");
  await input.fill("lineage");
  await page
    .getByRole("dialog")
    .getByRole("link", { name: /Explain a value/ })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Lineage coverage",
  );
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("mobile navigation, theme persistence and reduced motion", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("./");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(
    await page
      .locator(".flow-lines path")
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
  await page.screenshot({
    path: testInfo.outputPath("website-mobile.png"),
    fullPage: true,
  });
  const theme = page.getByRole("switch", { name: "Dark theme" });
  await expect(theme).not.toBeChecked();
  await theme.focus();
  await page.keyboard.press("Space");
  await expect(theme).toBeChecked();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(theme).toBeChecked();
  await page.getByLabel("Navigation menu").click();
  await page
    .getByRole("navigation", { name: "Mobile navigation", exact: true })
    .getByRole("link", { name: "Documentation" })
    .click();
  await page.getByText("Browse documentation", { exact: true }).click();
  await page
    .getByRole("navigation", { name: "Documentation on mobile" })
    .getByRole("link", { name: "Version control" })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});

test("content and documentation navigation remain usable without JavaScript", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    baseURL,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("./");
  await page.getByRole("link", { name: "Build your first pipeline" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Your first pipeline",
  );
  await page.getByText("Browse documentation", { exact: true }).click();
  await page
    .getByRole("navigation", { name: "Documentation on mobile" })
    .getByRole("link", { name: "Connections", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Connections and connector compatibility",
  );
  await page
    .getByRole("navigation", { name: "Footer", exact: true })
    .getByRole("link", { name: "Releases", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "What’s new in Duckpad.",
  );
  const olderRelease = page.locator(".release-entry").nth(1);
  await olderRelease.locator("summary").click();
  await expect(olderRelease.locator(".release-body")).toBeVisible();
  await context.close();
});

test("release notes match the feed and remain readable on mobile", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const feed = await (await page.request.get("releases.json")).json();
  expect(feed.length).toBeGreaterThanOrEqual(2);
  await page.goto("releases/");
  await expect(page.locator(".release-entry")).toHaveCount(feed.length);
  for (const release of feed) {
    await expect(
      page.getByRole("heading", { name: release.tag, exact: true }),
    ).toBeVisible();
  }
  await expect(page.locator(".release-body").first()).toContainText(
    "pip install duckpad==",
  );
  await expect(page.getByText("Latest release", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Release and downloads on GitHub" }).first(),
  ).toHaveAttribute(
    "href",
    /^https:\/\/github.com\/hugues31\/duckpad\/releases\/tag\//,
  );
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
