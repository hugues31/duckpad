import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { signIn } from "../e2e/helpers";

// Pacing is intentional: these tests produce a watchable demonstration as well as assertions.
async function point(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("The recorded action must be visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 24,
  });
  await page.waitForTimeout(450);
}
async function click(page: Page, locator: Locator) {
  await point(page, locator);
  await locator.click();
  await page.waitForTimeout(650);
}
function timestamp(seconds: number) {
  return new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
}

test("record a real pipeline, source lineage and SQL workspace", async ({
  browser,
  page: setup,
}, testInfo) => {
  await signIn(setup);
  await setup
    .getByRole("button", { name: "Open example project", exact: true })
    .click();
  await expect(
    setup.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeVisible();

  const media = resolve("../website/public/demos");
  await mkdir(media, { recursive: true });
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    storageState: await setup.context().storageState(),
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    colorScheme: "light",
    recordVideo: {
      dir: testInfo.outputPath("recording"),
      size: { width: 1440, height: 900 },
    },
  });
  await context.addInitScript(() => {
    localStorage.setItem("duckpad-theme", "light");
    localStorage.setItem("duckpad-language", "en");
    document.addEventListener("DOMContentLoaded", () => {
      const cursor = document.createElement("div");
      cursor.id = "demo-cursor";
      cursor.setAttribute("aria-hidden", "true");
      cursor.style.cssText =
        "position:fixed;left:0;top:0;width:26px;height:32px;pointer-events:none;z-index:2147483647;transform:translate(16px,16px);filter:drop-shadow(0 2px 2px #0005)";
      cursor.innerHTML =
        '<svg viewBox="0 0 24 30"><path d="M3 2v23l6-7 5 10 4-2-5-10h9Z" fill="white" stroke="#17233c" stroke-width="2"/></svg>';
      document.body.append(cursor);
      document.addEventListener("mousemove", (event) => {
        cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
      });
      document.addEventListener("mousedown", () => {
        cursor.style.filter = "drop-shadow(0 0 7px #226bff)";
      });
      document.addEventListener("mouseup", () => {
        cursor.style.filter = "drop-shadow(0 2px 2px #0005)";
      });
    });
  });
  const page = await context.newPage();
  const video = page.video()!;
  const start = Date.now();
  const cues: { time: number; text: string }[] = [];
  const caption = (text: string) =>
    cues.push({ time: (Date.now() - start) / 1000, text });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    caption("Northstar: a complete pipeline with local CSV and Parquet data.");
    await page.goto(setup.url());
    await expect(page.locator(".react-flow__node")).toHaveCount(9);
    await page.waitForTimeout(1200);
    caption("Run the pipeline. DuckDB computes each step and its outputs.");
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
    );
    await click(
      page,
      page.getByRole("button", { name: "Run pipeline", exact: true }),
    );
    const run = await (await response).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
        { timeout: 30000 },
      )
      .toBe("success");
    caption("Select Regional revenue to inspect the report output.");
    await click(
      page,
      page
        .locator(".react-flow__node")
        .filter({ has: page.getByText("Regional revenue", { exact: true }) }),
    );
    await point(page, page.getByLabel("Output", { exact: true }));
    await page.getByLabel("Output", { exact: true }).selectOption("report");
    const revenue = page.getByRole("button", {
      name: /Explain this value: revenue, rows 1,/,
    });
    await expect(revenue).toBeVisible();
    await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
    await page.waitForTimeout(1200);
    caption(
      "Click a revenue value to see the calculation and its contributions.",
    );
    await click(page, revenue);
    await expect(
      page.getByRole("dialog", { name: "How this value was calculated" }),
    ).toBeVisible();
    await page.waitForTimeout(1200);
    caption(
      "The graph connects source amounts to the calculation, skipping unchanged values.",
    );
    await expect(page.locator(".lineage-dialog")).toContainText(
      "Sum of 27 contributing values",
      { ignoreCase: true },
    );
    await expect(
      page.locator(".lineage-dialog .lineage-card.is-source").first(),
    ).toContainText("amount");
    await page.waitForTimeout(1400);
    caption("Page through all contributing cells, five at a time.");
    await click(
      page,
      page
        .locator(".lineage-dialog")
        .getByRole("button", { name: "Next", exact: true }),
    );
    await expect(page.locator(".lineage-dialog .lineage-page")).toContainText(
      "6–10 / 27",
    );
    await page.waitForTimeout(1400);
    await click(
      page,
      page.locator(".lineage-dialog").getByTitle("Close", { exact: true }),
    );
    caption(
      "Open Code to inspect the SQL and project files behind the visual flow.",
    );
    await click(page, page.getByRole("link", { name: "Code", exact: true }));
    await expect(page.locator(".code-workspace .monaco-editor")).toBeVisible();
    await click(
      page,
      page.getByRole("treeitem", { name: "templates/sql.sql", exact: true }),
    );
    await expect(page.locator(".code-file-heading")).toContainText(
      "templates/sql.sql",
    );
    await page.waitForTimeout(1500);
    caption(
      "Your data, your logic, your workspace. Start with the Northstar tour.",
    );
    await click(page, page.getByRole("link", { name: "Flow", exact: true }));
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
    const end = (Date.now() - start) / 1000;
    await context.close();
    await video.saveAs(resolve(media, "northstar.webm"));
    await writeFile(
      resolve(media, "northstar.vtt"),
      "WEBVTT\n\n" +
        cues
          .map(
            (cue, index) =>
              `${timestamp(cue.time)} --> ${timestamp(cues[index + 1]?.time ?? end)}\n${cue.text}\n`,
          )
          .join("\n"),
    );
  } finally {
    await context.close();
  }
});
