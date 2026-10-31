import { expect, test } from "@playwright/test";
import { openInstanceSettings, submitLogin } from "./helpers";
import type { Snapshot } from "../src/types";

for (const secureContext of [false, true]) {
  test(`nodes and connections persist in a ${secureContext ? "secure" : "plain HTTP"} context`, async ({
    page,
    baseURL,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const origin = secureContext ? baseURL! : "http://duckpad-http.test";
    if (!secureContext) {
      // Serve the real backend under a non-loopback HTTP origin. Browser crypto
      // APIs remain untouched, including the absence of randomUUID in HTTP.
      await page.route(`${origin}/**`, async (route) => {
        const url = new URL(route.request().url());
        const response = await route.fetch({
          url: `${baseURL}${url.pathname}${url.search}`,
          headers: { ...route.request().headers(), host: url.host },
        });
        await route.fulfill({ response });
      });
    }
    await page.goto(origin);
    expect(
      await page.evaluate(() => ({
        secure: window.isSecureContext,
        randomUUID: typeof crypto.randomUUID,
        getRandomValues: typeof crypto.getRandomValues,
      })),
    ).toEqual({
      secure: secureContext,
      randomUUID: secureContext ? "function" : "undefined",
      getRandomValues: "function",
    });
    await submitLogin(page);
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "New project",
      exact: true,
    });
    await dialog.getByLabel("Name", { exact: true }).fill("HTTP identifiers");
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".react-flow__node")).toHaveCount(0);

    for (const [index, label] of ["Load CSV", "Filter"].entries()) {
      await page
        .locator(".palette-item")
        .filter({ has: page.getByText(label, { exact: true }) })
        .dragTo(page.locator(".react-flow__pane"), {
          targetPosition: { x: 350 + index * 250, y: 240 },
        });
      await expect(page.locator(".react-flow__node")).toHaveCount(index + 1);
    }

    const worktree = new URL(page.url()).pathname.split("/")[2];
    const endpoint = `/api/worktrees/${worktree}`;
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(endpoint) &&
        response.request().method() === "PUT",
    );
    await page
      .locator(".inspector")
      .getByLabel("source", { exact: true })
      .selectOption({ index: 1 });
    expect((await saved).ok()).toBe(true);

    const snapshot: Snapshot = await page.evaluate(
      async (url) => (await fetch(url)).json(),
      endpoint,
    );
    const graph = snapshot.bundle!.flow;
    expect(graph.nodes).toHaveLength(2);
    expect(new Set(graph.nodes.map((node) => node.id)).size).toBe(2);
    for (const node of graph.nodes)
      expect(node.id).toMatch(/^node_[0-9a-f]{12}$/);
    expect(graph.edges).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^edge_[0-9a-f]{12}$/),
        source: graph.nodes[0].id,
        sourceHandle: "result",
        target: graph.nodes[1].id,
        targetHandle: "source",
      }),
    ]);

    await page.reload();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    for (const node of graph.nodes)
      await expect(
        page.locator(`.react-flow__node[data-id="${node.id}"]`),
      ).toHaveCount(1);
    await expect(page.locator(".react-flow__edge")).toHaveCount(1);

    // Assistant providers also receive client-generated identifiers.
    await openInstanceSettings(page, "AI assistant");
    // Earlier tests may leave a provider, which hides the provider choice.
    const add = page.getByRole("button", { name: "Add provider", exact: true });
    const openai = page.getByRole("button", { name: "OpenAI", exact: true });
    await expect(add.or(openai)).toBeVisible();
    if (await add.isVisible()) await add.click();
    await openai.click();
    await expect(
      page.getByRole("group", { name: "OpenAI", exact: true }).last(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
