import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

test("scroll reveals stagger cards and respect live motion preferences", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("./");
  const cards = page.locator(".feature-card");
  await expect(cards.first()).toHaveAttribute("data-reveal-pending", "");
  await cards
    .first()
    .evaluate((element) =>
      element.scrollIntoView({ block: "center", behavior: "instant" }),
    );
  await expect(cards.first()).not.toHaveAttribute("data-reveal-pending");
  const delays = await cards.evaluateAll((elements) =>
    elements
      .slice(0, 3)
      .map(
        (element) => getComputedStyle(element).transitionDelay.split(",")[0],
      ),
  );
  expect(delays).toEqual(["0s", "0.09s", "0.18s"]);
  await expect
    .poll(() =>
      cards.first().evaluate((element) => element.getAnimations().length),
    )
    .toBeGreaterThan(0);
  await expect(page.locator("[data-reveal-pending]").first()).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("[data-reveal-pending]")).toHaveCount(0);
  await expect(cards.first()).toHaveCSS("opacity", "1");
  expect(
    await cards.first().evaluate((element) => element.getAnimations().length),
  ).toBe(0);
});

test("guide reveals keep keyboard focus and anchor targets immediately readable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("./");
  const card = page.locator(".feature-card").last();
  await expect(card).toHaveAttribute("data-reveal-pending", "");
  await card.focus();
  await expect(card).toHaveCSS("opacity", "1");
  expect(await card.evaluate((element) => element.getAnimations().length)).toBe(
    0,
  );

  await page.goto("docs/quickstart/");
  const image = page.locator('.prose [data-reveal="media"]').first();
  await expect(image).toHaveAttribute("data-reveal-pending", "");
  await image.evaluate((element) =>
    element.scrollIntoView({ block: "center", behavior: "instant" }),
  );
  await expect(image).not.toHaveAttribute("data-reveal-pending");
  await expect
    .poll(() => image.evaluate((element) => element.getAnimations().length))
    .toBeGreaterThan(0);
  const heading = page.locator(".prose > h2").last();
  const id = await heading.getAttribute("id");
  await page.evaluate((id) => {
    location.hash = id!;
  }, id);
  await expect(heading).toHaveCSS("opacity", "1");
  expect(
    await heading.evaluate((element) => element.getAnimations().length),
  ).toBe(0);
});

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
    .toBe(1920);
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.duration),
  ).toBeCloseTo(60, 0);
  await expect(video).toHaveAttribute("preload", "none");
  await expect(video).not.toHaveAttribute("autoplay");
  await expect(caption).toHaveAttribute("srclang", "en");
  await video.evaluate((element: HTMLVideoElement) => element.pause());
  await page
    .getByRole("link", { name: "Build your first pipeline", exact: true })
    .click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Duckpad in 15 minutes",
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

test("custom video controls support keyboard playback, seeking, audio, captions and fullscreen", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(".mp4")) mediaRequests.push(request.url());
  });
  await page.goto("./");
  const player = page.locator("[data-product-video]");
  const video = player.locator("video");
  await expect(player).toHaveAttribute("data-enhanced", "true");
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.controls),
  ).toBe(false);
  expect(mediaRequests).toEqual([]);
  await player.scrollIntoViewIfNeeded();
  await player.screenshot({ path: testInfo.outputPath("video-poster.png") });

  const cover = player.getByRole("button", { name: /Watch the film/ });
  await cover.focus();
  await page.keyboard.press("Enter");
  const pause = player.getByRole("button", {
    name: "Pause video",
    exact: true,
  });
  await expect(pause).toBeFocused();
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await page.keyboard.press("Space");
  await expect(
    player.getByRole("button", { name: "Play video", exact: true }),
  ).toBeFocused();
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.paused),
  ).toBe(true);

  const progress = player.getByRole("slider", { name: "Video progress" });
  await progress.fill("25");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeCloseTo(25, 1);
  await expect(progress).toHaveAttribute("aria-valuetext", "0:25 of 1:00");
  await progress.focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(25);

  const captions = player.getByRole("button", { name: "English captions" });
  await expect(captions).toHaveAttribute("aria-pressed", "true");
  await captions.click();
  expect(
    await video.evaluate(
      (element: HTMLVideoElement) => element.textTracks[0].mode,
    ),
  ).toBe("disabled");
  await captions.click();
  await expect
    .poll(() =>
      video.evaluate(
        (element: HTMLVideoElement) => element.textTracks[0].cues?.length,
      ),
    )
    .toBeGreaterThan(0);
  expect(
    await video.evaluate(
      (element: HTMLVideoElement) => element.textTracks[0].mode,
    ),
  ).toBe("showing");

  await player
    .getByRole("slider", { name: "Volume", exact: true })
    .fill("0.35");
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.volume),
  ).toBeCloseTo(0.35);
  await player.getByRole("button", { name: "Mute video", exact: true }).click();
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.muted),
  ).toBe(true);
  await player
    .getByRole("button", { name: "Unmute video", exact: true })
    .click();
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.muted),
  ).toBe(false);
  expect(
    await video.evaluate((element: HTMLVideoElement) => element.volume),
  ).toBeCloseTo(0.35);

  await player.getByRole("button", { name: "Enter fullscreen" }).click();
  await expect
    .poll(() =>
      player.evaluate((element) => document.fullscreenElement === element),
    )
    .toBe(true);
  await expect(
    player.getByRole("button", { name: "Exit fullscreen" }),
  ).toBeVisible();
  await player.getByRole("button", { name: "Exit fullscreen" }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);
  expect(
    (
      await new AxeBuilder({ page })
        .include("[data-product-video]")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
  await player.screenshot({ path: testInfo.outputPath("video-controls.png") });

  await progress.fill("59.7");
  await player.getByRole("button", { name: "Play video", exact: true }).click();
  await expect(
    player.getByRole("button", { name: /Watch again/ }),
  ).toBeVisible();
  await player.getByRole("button", { name: /Watch again/ }).click();
  await expect(pause).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeLessThan(5);
});

test("video controls fit a touch screen in both themes", async ({
  browser,
  baseURL,
}, testInfo) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 360, height: 780 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto("./");
  const player = page.locator("[data-product-video]");
  await player.scrollIntoViewIfNeeded();
  await player.screenshot({
    path: testInfo.outputPath("video-mobile-light.png"),
  });
  await player.getByRole("button", { name: /Watch the film/ }).tap();
  await expect
    .poll(() =>
      player
        .locator("video")
        .evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await player.getByRole("button", { name: "Pause video" }).tap();
  await player.getByRole("button", { name: "English captions" }).tap();
  await expect(
    player.getByRole("button", { name: "English captions" }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("switch", { name: "Dark theme" }).tap();
  await player.scrollIntoViewIfNeeded();
  await player.screenshot({
    path: testInfo.outputPath("video-mobile-dark.png"),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  for (const button of await player.getByRole("button").all()) {
    if (!(await button.isVisible())) continue;
    const bounds = (await button.boundingBox())!;
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  }
  await context.close();
});

test("unavailable video offers a direct link and playback retry", async ({
  page,
}) => {
  await page.route("**/duckpad-overview.mp4", (route) => route.abort());
  await page.goto("./");
  await page.getByRole("button", { name: /Watch the film/ }).click();
  await expect(page.locator(".video-message")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open the video directly" }),
  ).toHaveAttribute("href", /duckpad-overview\.mp4$/);
  await page.unroute("**/duckpad-overview.mp4");
  await page.getByRole("button", { name: /Watch the film/ }).click();
  await expect
    .poll(() =>
      page
        .locator("video")
        .evaluate((element: HTMLVideoElement) => element.currentTime),
    )
    .toBeGreaterThan(0);
  await expect(page.locator(".video-message")).not.toBeVisible();
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
  await expect(page.locator("video")).toHaveAttribute("controls", "");
  await expect(
    page.getByRole("group", { name: "Video controls" }),
  ).not.toBeVisible();
  await page.getByRole("link", { name: "Build your first pipeline" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Duckpad in 15 minutes",
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
