import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("workspace polling does not render the 105 canvas nodes again", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as typeof window & {
      nodeRenders: number;
      __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown;
    };
    state.nodeRenders = 0;
    // A commit that skips a node keeps its fiber, flags included, so the
    // PerformedWork flag (1) of its last render stays set. Count a node only
    // when this commit replaced its fiber; otherwise every later commit, such
    // as a resource monitor update, would count the nodes' last render again.
    const committed = new Map<string, unknown>();
    state.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      inject: () => 1,
      onCommitFiberRoot: (_id: number, root: any) => {
        const visit = (fiber: any) => {
          if (!fiber) return;
          if (fiber.elementType?.displayName === "PipelineNode") {
            const node = fiber.memoizedProps.id;
            if (committed.get(node) !== fiber && fiber.flags & 1)
              state.nodeRenders++;
            committed.set(node, fiber);
          }
          visit(fiber.child);
          visit(fiber.sibling);
        };
        visit(root.current);
      },
      onCommitFiberUnmount: () => {},
    };
  });
  await signIn(page);
  const tree = await (
    await page.request.post("/api/projects", {
      data: { name: "Polling renders" },
    })
  ).json();
  const endpoint = `/api/worktrees/${tree.id}`;
  const snapshot = await (await page.request.get(endpoint)).json();
  snapshot.bundle.flow.nodes = Array.from({ length: 105 }, (_, index) => ({
    id: `node_${index}`,
    template: "source",
    position: { x: (index % 15) * 180, y: Math.floor(index / 15) * 150 },
  }));
  snapshot.bundle.templates.source = "-- @output result\nSELECT 1 AS value;";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${tree.id}/flow`);
  await expect(page.locator(".react-flow__node")).toHaveCount(105);
  const renders = () =>
    page.evaluate(
      () => (window as typeof window & { nodeRenders: number }).nodeRenders,
    );
  await expect.poll(renders).toBeGreaterThanOrEqual(105);
  // Let initial port measurements settle, then observe one complete workspace poll.
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/workspace",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const before = await renders();
  await page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/workspace",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  expect(await renders()).toBe(before);
});
