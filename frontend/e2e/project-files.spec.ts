import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.use({ actionTimeout: 10000 });

test("a member reads an upload and exports it as project files, without any connection", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  const username = `files-${Date.now()}`;
  const password = "project-files-browser-password";
  expect(
    (
      await page.request.post("/api/users", {
        data: { username, password, role: "member" },
      })
    ).ok(),
  ).toBeTruthy();
  await page.request.post("/api/logout");
  expect(
    (
      await page.request.post("/api/login", { data: { username, password } })
    ).ok(),
  ).toBeTruthy();
  const worktree = await (
    await page.request.post("/api/projects", { data: { name: "Budget" } })
  ).json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  try {
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await page.getByRole("button", { name: "Load CSV", exact: true }).click();
    const inspector = page.locator(".inspector");
    const location = inspector.getByRole("combobox", {
      name: "Location",
      exact: true,
    });
    // The project has no connection: project files are the only location.
    await expect(location).toHaveValue("");
    await expect(location.locator("option")).toHaveText(["Project files"]);
    await inspector.getByLabel("Upload file", { exact: true }).setInputFiles({
      name: "budget.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("id,amount\n1,10\n2,20\n"),
    });
    await expect(inspector.getByRole("textbox", { name: /file/ })).toHaveValue(
      /budget\.csv$/,
    );
    await expect
      .poll(
        async () =>
          (await (await page.request.get(endpoint)).json()).bundle.flow.nodes[0]
            ?.params.file,
      )
      .toMatch(/budget\.csv$/);
    const source = (await (await page.request.get(endpoint)).json()).bundle.flow
      .nodes[0].id;

    await page.getByRole("button", { name: "Export CSV", exact: true }).click();
    await inspector
      .getByLabel("source", { exact: true })
      .selectOption(`${source}:result`);
    await expect(location).toHaveValue("");
    await expect
      .poll(
        async () =>
          (await (await page.request.get(endpoint)).json()).bundle.flow.edges
            .length,
      )
      .toBe(1);
    const launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    const run = await (await launched).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
        { timeout: 30000 },
      )
      .toBe("success");
    const preview = await (
      await page.request.get(`${endpoint}/preview/${source}?environment=dev`)
    ).json();
    expect(preview.rows.map((row: any) => row.values)).toEqual([
      [1, 10],
      [2, 20],
    ]);

    // The export wrote to the project's exports, offered for download.
    const downloadButton = page
      .getByRole("region", { name: "Results", exact: true })
      .getByRole("button", { name: "Download exported data", exact: true });
    await expect(downloadButton).toBeEnabled();
    const pendingDownload = page.waitForEvent("download");
    await downloadButton.click();
    const downloaded = await pendingDownload;
    expect(downloaded.suggestedFilename()).toBe("export.csv");
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
  }
});
