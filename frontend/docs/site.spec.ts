import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

test("scroll reveals cards and respect live motion preferences", async ({
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
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("./");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
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
    .toBeGreaterThan(0);
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
}) => {
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
}) => {
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

test("search results support arrows, query changes and Enter from the homepage", async ({
  page,
}) => {
  await page.goto("./");
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByRole("searchbox", { name: "Search documentation" });
  const links = page.locator(".search-results a");
  await input.fill("lineage");
  await expect(links.nth(1)).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(links.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(links.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(links.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(input).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await page.keyboard.type(" no-such-guide");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("lineage no-such-guide");
  await expect(links).toHaveCount(0);
  for (const key of ["ArrowDown", "ArrowUp", "Enter"]) {
    await page.keyboard.press(key);
    await expect(input).toBeFocused();
  }
  await input.fill("lineage");
  await expect(links.nth(1)).toBeVisible();
  await page.keyboard.press("ArrowUp");
  await expect(links.last()).toBeFocused();
  const list = (await page.locator(".search-results").boundingBox())!;
  const last = (await links.last().boundingBox())!;
  expect(last.y).toBeGreaterThanOrEqual(list.y);
  expect(last.y + last.height).toBeLessThanOrEqual(list.y + list.height);
  await page.keyboard.press("ArrowDown");
  await expect(links.last()).toBeFocused();
  const destination = await links.last().getAttribute("href");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new URL(destination!, page.url()).href);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

for (const width of [1440, 768, 320]) {
  test(`the shared header opens search on every page at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const route of [
      "./",
      "docs/",
      "docs/quickstart/",
      "releases/",
      "404.html",
    ]) {
      await page.goto(route);
      const search = page
        .locator(".site-header")
        .getByRole("button", { name: "Search documentation" });
      await search.click();
      await expect(page.getByRole("searchbox")).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(search).toBeFocused();
      await page.keyboard.press("ControlOrMeta+k");
      await expect(page.getByRole("searchbox")).toBeFocused();
      await page.getByRole("button", { name: "Close search" }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  });
}

for (const width of [1440, 1024, 768, 390, 320]) {
  test(`sticky header keeps anchor targets and feature cards readable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("docs/quickstart/");
    const heading = page.locator(".prose > h2").nth(2);
    const id = await heading.getAttribute("id");
    await page.evaluate((id) => {
      location.hash = id!;
    }, id);
    const header = page.locator(".site-header");
    await expect.poll(async () => (await header.boundingBox())!.y).toBe(0);
    // Below 1100 px, the outline bar sticks under the header: clear both.
    await expect
      .poll(async () => {
        const covered = await page.evaluate(() =>
          Math.max(
            ...[".site-header", ".mobile-toc"]
              .map((selector) => document.querySelector(selector))
              .filter((element) => element?.getClientRects().length)
              .map((element) => element!.getBoundingClientRect().bottom),
          ),
        );
        return (await heading.boundingBox())!.y - covered;
      })
      .toBeGreaterThanOrEqual(0);

    await page.goto("./#features");
    await expect.poll(async () => (await header.boundingBox())!.y).toBe(0);
    const card = page.locator(".feature-card").first();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await card.click();
    await expect(page).toHaveURL(/\/docs\/sql\/$/);
  });
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`mobile menu links receive taps with ${reducedMotion} motion`, async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({
      baseURL,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      reducedMotion,
    });
    const page = await context.newPage();
    const toggle = page.getByLabel("Navigation menu");
    const menu = page.getByRole("navigation", {
      name: "Mobile navigation",
      exact: true,
    });
    await page.goto("docs/quickstart/");
    await toggle.tap();
    await menu.getByRole("link", { name: "Releases", exact: true }).tap();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "What’s new in Duckpad.",
    );
    await toggle.tap();
    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
    await expect(menu).not.toBeVisible();
    await toggle.tap();
    await menu.getByRole("link", { name: "Why Duckpad", exact: true }).tap();
    await expect(page).toHaveURL(/\/#features$/);
    await toggle.tap();
    await menu.getByRole("link", { name: "Documentation", exact: true }).tap();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Duckpad in 15 minutes",
    );
    await context.close();
  });
}

test("mobile navigation, theme persistence and reduced motion", async ({
  page,
}) => {
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
  await page.getByLabel("Navigation menu").click();
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
  await page.getByLabel("Navigation menu").click();
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
  await expect(page.locator(".release-body").nth(1)).toBeVisible();
  const maintenance = page.locator("details.release-group").first();
  await expect(maintenance.locator("ul")).not.toBeVisible();
  await maintenance.locator("summary").click();
  await expect(maintenance.locator("ul")).toBeVisible();
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
  await expect(page.locator(".release-install").first()).toContainText(
    "pip install duckpad==",
  );
  await expect(
    page.locator(".release-entry").first().getByText("Latest release"),
  ).toBeVisible();
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

test("the guide outline follows the reading position", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("docs/installation/");
  const outline = page.getByRole("navigation", {
    name: "On this page",
    exact: true,
  });
  await expect(outline.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  // Third-level sections are nested under the section they belong to.
  await expect(
    outline.locator("ul ul").getByRole("link", {
      name: "Platform requirements",
    }),
  ).toBeVisible();

  const heading = page.locator(".prose > h3").nth(2);
  const id = await heading.getAttribute("id");
  await page.evaluate((id) => {
    location.hash = id!;
  }, id);
  await expect(outline.locator(`a[href="#${id}"]`)).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(outline.locator("[aria-current]")).toHaveCount(1);

  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const last = outline.getByRole("link").last();
  await expect(last).toHaveAttribute("aria-current", "true");
  // A chosen section stays highlighted even when it cannot reach the top.
  const previous = outline.getByRole("link").nth(-2);
  await previous.click();
  await expect(previous).toHaveAttribute("aria-current", "true");
  await expect(last).not.toHaveAttribute("aria-current");

  const pagination = page.getByRole("navigation", {
    name: "Previous and next guides",
  });
  await expect(pagination.getByRole("link")).toHaveCount(1);
  await pagination.getByRole("link", { name: /Next.*Duckpad in 15/ }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Duckpad in 15 minutes",
  );
  await expect(
    pagination.getByRole("link", { name: /Previous.*Installation/ }),
  ).toBeVisible();
  await expect(
    pagination.getByRole("link", { name: /Next.*Use your own data/ }),
  ).toBeVisible();
});

test("the mobile outline shows and changes the current section", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto("docs/installation/");
  const bar = page.locator(".mobile-toc");
  await expect(bar.locator("summary")).toContainText("Overview");
  await bar.locator("summary").tap();
  const sections = page.getByRole("navigation", {
    name: "Sections of this page",
  });
  await sections.getByRole("link", { name: "Upgrades and backups" }).tap();
  await expect(sections).not.toBeVisible();
  await expect(bar.locator("summary")).toContainText("Upgrades and backups");
  const heading = page.getByRole("heading", {
    name: "Upgrades and backups",
    level: 2,
  });
  await expect
    .poll(async () => {
      const box = (await bar.boundingBox())!;
      return (await heading.boundingBox())!.y - (box.y + box.height);
    })
    .toBeGreaterThanOrEqual(0);
  // A tap outside the open outline closes it.
  await bar.locator("summary").tap();
  await expect(sections).toBeVisible();
  await page.touchscreen.tap(195, 800);
  await expect(sections).not.toBeVisible();
  await context.close();
});

test("the mobile menu opens on the current guide and covers the page", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto("docs/sso/");
  await page.getByLabel("Navigation menu").tap();
  const guides = page.getByRole("navigation", {
    name: "Documentation on mobile",
  });
  const current = guides.getByRole("link", { name: "Single sign-on" });
  await expect(current).toHaveAttribute("aria-current", "page");
  await expect(current).toBeInViewport();
  const overflow = () =>
    page.evaluate(() => getComputedStyle(document.documentElement).overflow);
  expect(await overflow()).toBe("hidden");
  await guides.getByRole("link", { name: "Data tests", exact: true }).tap();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Data tests",
  );
  await expect(guides).not.toBeVisible();
  expect(await overflow()).not.toBe("hidden");
  await context.close();
});

test("release versions follow the reading position and flag breaking changes", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const feed: { tag: string; body: string }[] = await (
    await page.request.get("releases.json")
  ).json();
  await page.goto("releases/");
  const versions = page.getByRole("navigation", {
    name: "Versions",
    exact: true,
  });
  await expect(versions.getByRole("link").first()).toHaveAttribute(
    "aria-current",
    "true",
  );
  const second = versions.getByRole("link").nth(1);
  await second.click();
  await expect(second).toHaveAttribute("aria-current", "true");
  await expect(versions.locator("[aria-current]")).toHaveCount(1);

  for (const release of feed) {
    const id = `release-${encodeURIComponent(release.tag)}`;
    const breaking = /^### Breaking changes$/m.test(release.body);
    await expect(
      versions.locator(`a[href="#${id}"] .breaking-mark`),
    ).toHaveCount(breaking ? 1 : 0);
    await expect(
      page.locator(`[id="${id}"] .release-group[data-kind="breaking-changes"]`),
    ).toHaveCount(breaking ? 1 : 0);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const bar = page.locator(".mobile-toc");
  await bar.locator("summary").click();
  const last = page
    .getByRole("navigation", { name: "Versions on mobile" })
    .getByRole("link")
    .last();
  const tag = (await last.getAttribute("data-label"))!;
  await last.click();
  await expect(bar.locator("summary")).toContainText(tag);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
