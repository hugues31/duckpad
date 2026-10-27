import { expect, test, type Page } from "@playwright/test";
import { openInstanceSettings, signIn } from "./helpers";

async function project(page: Page) {
  const result = await (
    await page.request.post("/api/projects", {
      data: { name: "Environment checks" },
    })
  ).json();
  await page.evaluate(
    (id) => localStorage.setItem("duckpad-worktree", id),
    result.id,
  );
  await page.reload();
  return result.id as string;
}

async function waitForRun(page: Page, id: string) {
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${id}`)).json()).status,
    )
    .toBe("success");
  await expect(
    page.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeEnabled();
}

test("manage environment labels, colors, confirmation and selected-environment deletion", async ({
  page,
}) => {
  await signIn(page);
  const worktree = await project(page);
  const before = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  try {
    await openInstanceSettings(page, "Environments");
    await expect(
      page.getByRole("article", { name: "dev", exact: true }),
    ).toContainText("Run without confirmation");
    await expect(
      page.getByRole("article", { name: "prod", exact: true }),
    ).toContainText("Confirm every run");
    await page
      .getByRole("button", { name: "Add environment", exact: true })
      .click();
    await page.getByLabel("ID", { exact: true }).fill("qa_ui");
    await page.getByLabel("Label", { exact: true }).fill("Quality assurance");
    await page.getByLabel("Color", { exact: true }).fill("#7c3aed");
    await page.getByLabel("Confirm every run", { exact: true }).check();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Edit · Quality assurance", exact: true })
      .click();
    await expect(page.getByLabel("ID", { exact: true })).toBeDisabled();
    await page.getByLabel("Label", { exact: true }).fill("Release candidate");
    await page.getByLabel("Color", { exact: true }).fill("#123abc");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await openInstanceSettings(page, "Environments");
    const card = page.getByRole("article", {
      name: "Release candidate",
      exact: true,
    });
    await expect(card.locator(".env-dot")).toHaveCSS(
      "background-color",
      "rgb(18, 58, 188)",
    );
    await expect(card).toContainText("Confirm every run");
    await page.setViewportSize({ width: 800, height: 900 });
    await page.screenshot({
      path: "test-results/environments.png",
      fullPage: true,
    });
    await openInstanceSettings(page, "Connections");
    await page
      .getByRole("button", { name: "New connection", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Release candidate", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Pipelines", exact: true }).click();
    await page.getByLabel("Environment", { exact: true }).selectOption("qa_ui");
    await expect(page.locator(".environment-picker .select-value")).toHaveText(
      "Release candidate",
    );
    await expect(page.locator(".environment-picker .env-dot")).toHaveCSS(
      "background-color",
      "rgb(18, 58, 188)",
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Confirm execution" }),
    ).toContainText("Release candidate");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await openInstanceSettings(page, "Environments");
    await page
      .getByRole("button", { name: "Delete · Release candidate", exact: true })
      .click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toBeVisible();
    await page
      .getByRole("button", { name: "Delete · Release candidate", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(card).toHaveCount(0);
    await page.getByRole("button", { name: "Pipelines", exact: true }).click();
    await expect(page.getByLabel("Environment", { exact: true })).toHaveValue(
      "dev",
    );
    expect(
      (await (await page.request.get(`/api/worktrees/${worktree}`)).json())
        .commit,
    ).toBe(before.commit);
  } finally {
    await page.request.delete("/api/environments/qa_ui");
  }
});

test("confirmation gates every pipeline and node run, including stale clients", async ({
  page,
}) => {
  await signIn(page);
  const worktree = await project(page);
  const snapshot = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  const bundle = snapshot.bundle;
  bundle.templates.constant =
    "-- @label Constant\n-- @output result\nSELECT 1 AS value;\n";
  bundle.flow.nodes = [
    {
      id: "constant",
      template: "constant",
      label: "Constant",
      params: {},
      position: { x: 100, y: 100 },
    },
  ];
  expect(
    (
      await page.request.put(`/api/worktrees/${worktree}`, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  const original = (await (await page.request.get("/api/workspace")).json())
    .catalog.environment_details;
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/runs"))
      requests.push(request.postDataJSON());
  });
  try {
    let launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await waitForRun(page, (await (await launched).json()).id);
    expect(requests).toHaveLength(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByLabel("Environment", { exact: true }).selectOption("prod");
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Confirm execution",
      exact: true,
    });
    await expect(dialog).toContainText("prod");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests).toHaveLength(1);
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(requests).toHaveLength(1);
    for (let index = 0; index < 2; index++) {
      await page
        .getByRole("button", { name: "Run pipeline", exact: true })
        .click();
      await expect(dialog).toBeVisible();
      launched = page.waitForResponse(
        (response) =>
          response.url().endsWith("/runs") &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Confirm and run", exact: true })
        .click();
      await waitForRun(page, (await (await launched).json()).id);
      expect(requests).toHaveLength(index + 2);
    }
    await page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("Constant", { exact: true }) })
      .click();
    await page.locator(".run-node").click();
    await expect(dialog).toContainText("constant");
    launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Confirm and run", exact: true })
      .click();
    const result = await (await launched).json();
    await waitForRun(page, result.id);
    expect(requests.at(-1)).toMatchObject({
      environment: "prod",
      node: "constant",
      confirmed: true,
    });
    // The browser still has dev's original setting; the server must challenge it.
    await page.request.put("/api/environments/dev", {
      data: { ...original[0], confirm_before_run: true },
    });
    await page.getByLabel("Environment", { exact: true }).selectOption("dev");
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await expect(dialog).toContainText("dev");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const runs = await (
      await page.request.get(`/api/runs?worktree=${worktree}`)
    ).json();
    expect(runs).toHaveLength(4);
  } finally {
    await page.request.put("/api/environments/dev", { data: original[0] });
  }
});
