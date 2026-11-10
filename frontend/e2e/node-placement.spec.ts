import { test, expect, type Page } from "@playwright/test";
import { canvasZoom, signIn } from "./helpers";

async function openProject(page: Page) {
  await signIn(page);
  const response = await page.request.post("/api/example", { data: {} });
  expect(response.ok()).toBe(true);
  const { id } = await response.json();
  await page.goto(`/worktrees/${id}/flow`);
  await expect(
    page.locator(".palette").getByRole("button", { name: "SQL", exact: true }),
  ).toBeVisible();
}

async function addNode(page: Page, label = "SQL") {
  const before = await page.locator(".react-flow__node").count();
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes("/api/worktrees/") &&
      response.request().method() === "PUT",
  );
  await page
    .locator(".palette")
    .getByRole("button", {
      name: label.replace("Add linked: ", ""),
      exact: true,
    })
    .click({ modifiers: label.startsWith("Add linked:") ? ["Alt"] : [] });
  expect((await saved).ok()).toBe(true);
  await expect(page.locator(".react-flow__node")).toHaveCount(before + 1);
  const created = page.locator(".react-flow__node").last();
  await expect(created).toHaveClass(/selected/);
  // The canvas must reveal the whole node in the area not covered by panels.
  await expect
    .poll(async () => {
      const bounds = (await created.boundingBox())!;
      const visible = (await page.locator(".canvas-safe-area").boundingBox())!;
      return (
        bounds.x >= visible.x - 1 &&
        bounds.y >= visible.y - 1 &&
        bounds.x + bounds.width <= visible.x + visible.width + 1 &&
        bounds.y + bounds.height <= visible.y + visible.height + 1
      );
    })
    .toBe(true);
  return (await created.getAttribute("data-id"))!;
}

async function expectNoOverlap(page: Page) {
  const overlaps = await page
    .locator(".react-flow__node")
    .evaluateAll((elements) => {
      const bounds = elements.map((element) => element.getBoundingClientRect());
      return bounds.flatMap((a, index) =>
        bounds
          .slice(index + 1)
          .filter(
            (b) =>
              a.left < b.right &&
              a.right > b.left &&
              a.top < b.bottom &&
              a.bottom > b.top,
          ),
      );
    });
  expect(overlaps).toEqual([]);
}

test("repeated Northstar palette additions avoid existing bounds after pan and zoom", async ({
  page,
}) => {
  test.setTimeout(90000);
  await openProject(page);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const visible = (await page.locator(".canvas-safe-area").boundingBox())!;
  await page.mouse.move(
    visible.x + visible.width - 15,
    visible.y + visible.height - 15,
  );
  await page.mouse.down();
  await page.mouse.move(
    visible.x + visible.width - 215,
    visible.y + visible.height - 115,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const zoom = () => canvasZoom(page);
  await expect.poll(zoom).not.toBeCloseTo(1, 2);
  const chosen = await zoom();
  for (const label of [
    "SQL",
    "Filter",
    "Add linked: Filter",
    "Regional report",
    "SQL",
    "Filter",
  ]) {
    await addNode(page, label);
    await expectNoOverlap(page);
    // Revealing a new node pans the canvas but keeps the user's zoom.
    expect(await zoom()).toBeCloseTo(chosen, 3);
  }
});
