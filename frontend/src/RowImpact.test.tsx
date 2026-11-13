// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { RowImpact, type RowImpactResult } from "./RowImpact";
import { readLineageTarget, writeLineageTarget } from "./lineageGraph";

const worktree = {
  id: "tree",
  environment: "dev",
  snapshot: { node_names: {}, revision: "revision" },
  statuses: { active: false },
  starting: false,
};
vi.mock("./worktree", () => ({ useLoadedWorktree: () => worktree }));
const target = {
  node: "source",
  direction: "impact" as const,
  cell: { dataset: "source_data", row: 0, column: "id" },
};
const ignore = () => {};
const view = () => (
  <RowImpact
    target={target}
    onMap={ignore}
    onHover={ignore}
    onOpen={ignore}
    onText={ignore}
  />
);
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  worktree.statuses.active = false;
});

it("pages duplicated rows and follows only the chosen occurrence", async () => {
  const requests: {
    offsets: Record<string, number>;
    choices: Record<string, number>;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      if (url.includes("/generations/")) return json({ valid: true });
      const request = JSON.parse(String(options?.body));
      requests.push(request);
      const offset = request.offsets.join || 0;
      const result: RowImpactResult = {
        node: "source",
        roots: ["join"],
        stops: [],
        reached: ["join"],
        complete: true,
        verdict: "",
        steps: [
          {
            id: "join",
            node: "Joined rows",
            state: "duplicated",
            name: "Joined rows",
            children: [],
            total: 8,
            offset,
            next_offset: offset === 0 ? 5 : null,
            row: request.choices.join || 0,
            columns: ["id"],
            rows: Array.from({ length: offset === 0 ? 5 : 3 }, (_, i) => ({
              row: offset + i,
              values: [offset + i],
            })),
          },
        ],
      };
      return json(result);
    }),
  );
  render(view());
  await screen.findByText("8 rows produced. Choose one to follow.");
  expect(document.querySelectorAll(".lineage-value")).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: "+ 3 more" }));
  await screen.findByRole("button", { name: "Row 7 · id = 6" });
  expect(document.querySelectorAll(".lineage-value")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Row 7 · id = 6" }));
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Row 7 · id = 6" })
        .getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(requests.at(-1)?.choices).toEqual({ join: 6 });
});

it("discards an in-flight result after recalculation starts", async () => {
  let answer: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.includes("/generations/")
        ? Promise.resolve(json({ valid: true }))
        : new Promise<Response>((resolve) => {
            answer = resolve;
          }),
    ),
  );
  const rendered = render(view());
  await waitFor(() => expect(answer).toBeDefined());
  worktree.statuses.active = true;
  rendered.rerender(view());
  answer!(
    json({
      node: "source",
      roots: [],
      steps: [],
      stops: [],
      reached: [],
      complete: true,
    }),
  );
  await screen.findByRole("alert");
  expect(document.querySelector(".row-impact")).toBeNull();
  worktree.statuses.active = false;
  rendered.rerender(view());
  expect(document.querySelector(".row-impact")).toBeNull();
});

it("round-trips a value Impact link without changing direction", () => {
  expect(
    readLineageTarget(writeLineageTarget(new URLSearchParams(), target)),
  ).toMatchObject(target);
});
