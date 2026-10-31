import { expect, type Page } from "@playwright/test";
import type { Run, Snapshot } from "../src/types";

/** Exercise the same approval and debug flow with a fake model or a configured real provider. */
export async function verifyAssistantRuns(page: Page) {
  const example = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const endpoint = `/api/worktrees/${example.id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  snapshot.bundle!.flow.nodes.push({
    id: "debug_source",
    label: "Debug source",
    params: {},
    position: { x: 100, y: 600 },
  });
  snapshot.bundle!.node_sql!["nodes/debug_source.sql"] =
    "-- @output result\nSELECT 1 AS value;\n";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.put("/api/environments/dev", {
        data: {
          label: "Development",
          color: "#3b82f6",
          confirm_before_run: true,
        },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${example.id}/flow`);
  await expect(
    page.locator('.react-flow__node[data-id="debug_source"]'),
  ).toBeVisible();
  const open = () =>
    page
      .getByRole("button", { name: "Open AI assistant", exact: true })
      .click();
  const chat = page.getByRole("dialog", { name: "AI assistant", exact: true });
  const ask = async (prompt: string) => {
    await chat
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(prompt);
    await chat.getByRole("button", { name: "Send", exact: true }).click();
  };
  const idle = async () => {
    await expect(
      chat.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0, { timeout: 150000 });
    await expect(chat.getByRole("alert")).toHaveCount(0);
  };
  const runs = async (): Promise<Run[]> =>
    (await page.request.get(`/api/runs?worktree=${example.id}`)).json();
  await open();
  await expect(
    chat.getByRole("button", { name: "Optimize the flow", exact: true }),
  ).toBeVisible();
  await chat
    .getByRole("button", { name: "Debug the latest run", exact: true })
    .click();
  await idle();
  await expect(chat.locator(".assistant-question").first()).toContainText(
    "Inspect the latest run",
  );
  await ask(
    "Run only node debug_source in dev. Use launch_run and ask me for confirmation. Do not change any code.",
  );
  await expect(
    chat.getByRole("button", { name: "Confirm and run", exact: true }),
  ).toBeVisible({ timeout: 150000 });
  await idle();
  expect(await runs()).toHaveLength(0);
  await expect(chat.locator(".assistant-run")).toContainText(
    "This environment requires confirmation",
  );
  // Save a predictable conversation title, then reload and resume the pending request.
  await chat
    .getByRole("button", { name: "Maximize assistant", exact: true })
    .click();
  await chat
    .getByRole("textbox", { name: "Conversation title", exact: true })
    .fill("Run approval example");
  await chat.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    chat.getByRole("button", { name: "Run approval example main" }),
  ).toBeVisible();
  await page.reload();
  await open();
  await chat
    .getByRole("button", { name: "Maximize assistant", exact: true })
    .click();
  await chat.getByRole("button", { name: "Run approval example main" }).click();
  await chat
    .getByRole("button", { name: "Confirm and run", exact: true })
    .click();
  await idle();
  await expect.poll(async () => (await runs())[0]?.status).toBe("success");
  expect((await runs())[0].entry_point).toBe("assistant");
  await expect(chat.locator(".assistant-run-status")).toContainText(
    "Succeeded",
  );
  // A second proposal is refused, and the refusal must reach the model without another run.
  await ask(
    "Run only node debug_source in dev again. Use launch_run and ask for confirmation. Do not change code.",
  );
  await expect(
    chat.getByRole("button", { name: "Decline run", exact: true }),
  ).toBeVisible({ timeout: 150000 });
  await idle();
  await chat.getByRole("button", { name: "Decline run", exact: true }).click();
  await idle();
  expect(await runs()).toHaveLength(1);
  await expect(chat.getByText("Run declined", { exact: true })).toBeVisible();
  await chat.getByRole("button", { name: "Close", exact: true }).click();
  // Produce a real binder error, then enter the chat from the failed run's UI.
  const changed: Snapshot = await (await page.request.get(endpoint)).json();
  changed.bundle!.node_sql!["nodes/debug_source.sql"] =
    "-- @output result\nSELECT missing_column;\n";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: changed.revision, bundle: changed.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  const failure = await page.request.post(`${endpoint}/runs`, {
    data: {
      environment: "dev",
      node: "debug_source",
      entry_point: "ui",
      confirmed: true,
    },
  });
  expect(failure.ok()).toBeTruthy();
  const failed: Run = await failure.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${failed.id}`)).json())
          .status,
    )
    .toBe("failed");
  await page.goto(`/worktrees/${example.id}/history`);
  await page.locator(".history-row").first().click();
  await page
    .getByRole("button", { name: "Ask the assistant", exact: true })
    .first()
    .click();
  await expect(chat).toBeVisible();
  await expect(
    chat.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue(new RegExp(failed.id));
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await idle();
  await expect(chat.locator(".assistant-markdown")).toContainText(
    "missing_column",
    { timeout: 150000 },
  );
  expect(await runs()).toHaveLength(2);
}
