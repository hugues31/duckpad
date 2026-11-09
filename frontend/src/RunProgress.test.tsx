// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import RunProgress from "./RunProgress";
import type { Run } from "./types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("updates the remaining time between polls and removes it when canceling", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const run = {
    id: "run",
    status: "running",
    environment: "dev",
    nodes: {
      a: {
        label: "A",
        writes_external: false,
        status: "running",
        started: new Date().toISOString(),
        estimated_duration: 120,
      },
    } as Run["nodes"],
  } as Run;
  const { rerender, unmount } = render(<RunProgress run={run} />);
  expect(screen.getByText("About 2 min left")).toBeTruthy();
  act(() => vi.advanceTimersByTime(61000));
  expect(screen.getByText("About 59 s left")).toBeTruthy();
  expect(
    screen.getByRole("progressbar").getAttribute("aria-valuetext"),
  ).toContain("About 59 s left");
  rerender(<RunProgress run={{ ...run, status: "canceling" }} />);
  expect(screen.queryByText(/left$/)).toBeNull();
  expect(vi.getTimerCount()).toBe(0);
  unmount();
});

it("shows an honest placeholder during preparation and the first untimed node", () => {
  const run = {
    id: "run",
    status: "preparing",
    environment: "dev",
    nodes: {},
  } as Run;
  const { rerender } = render(<RunProgress run={run} />);
  expect(screen.getByText("Estimating…")).toBeTruthy();
  rerender(
    <RunProgress
      run={{
        ...run,
        status: "running",
        nodes: { a: { status: "running", label: "A", writes_external: false } },
      }}
    />,
  );
  expect(screen.getByText("Estimating…")).toBeTruthy();
});
