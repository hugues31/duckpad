import { describe, expect, it } from "vitest";
import { remainingDuration, remainingSeconds } from "./runEstimate";
import type { NodeRun, Run } from "./types";

const now = Date.parse("2026-01-01T00:01:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const node = (state: Partial<NodeRun>): NodeRun => ({
  label: "Node",
  writes_external: false,
  status: "pending",
  ...state,
});
const run = (nodes: Record<string, NodeRun>, extra: Partial<Run> = {}) =>
  ({ id: "run", status: "running", started: ago(50), nodes, ...extra }) as Run;

describe("remainingSeconds", () => {
  it("uses the actual scope and subtracts the active node's elapsed time", () => {
    const current = run({
      done: node({ status: "success", duration: 2, estimated_duration: 80 }),
      active: node({
        status: "running",
        started: ago(4),
        estimated_duration: 10,
      }),
      pending: node({ estimated_duration: 20 }),
      blocked: node({ status: "blocked", estimated_duration: 100 }),
      failed: node({ status: "failed", estimated_duration: 100 }),
    });
    expect(remainingSeconds(current, now)).toBe(26);
    expect(remainingSeconds(current, now + 1000)).toBe(25);
  });

  it("falls back to completed node durations on the first run, excluding preparation", () => {
    expect(
      remainingSeconds(
        run({ a: node({ status: "running", started: ago(1) }) }),
        now,
      ),
    ).toBeNull();
    expect(
      remainingSeconds(
        run({
          a: node({ status: "success", duration: 6 }),
          b: node({ status: "success", duration: 2 }),
          c: node({ status: "running", started: ago(1) }),
          d: node({}),
        }),
        now,
      ),
    ).toBe(7);
  });

  it("combines partial history with an average for new nodes", () => {
    expect(
      remainingSeconds(
        run({
          a: node({ estimated_duration: 12 }),
          b: node({}),
        }),
        now,
      ),
    ).toBe(24);
    expect(
      remainingSeconds(
        run({
          a: node({ status: "success", duration: 4 }),
          b: node({ estimated_duration: 12 }),
          c: node({}),
        }),
        now,
      ),
    ).toBe(16);
  });

  it("never presents zero, negative, invalid, or terminal estimates", () => {
    for (const duration of [0, -1, NaN, Infinity])
      expect(
        remainingSeconds(
          run({ a: node({ estimated_duration: duration }) }),
          now,
        ),
      ).toBeNull();
    const nodes = {
      a: node({ status: "running", started: ago(20), estimated_duration: 10 }),
    };
    expect(remainingSeconds(run(nodes), now)).toBeNull();
    for (const status of [
      "preparing",
      "canceling",
      "canceled",
      "success",
      "failed",
      "interrupted",
    ] as const)
      expect(remainingSeconds(run(nodes, { status }), now)).toBeNull();
    expect(
      remainingSeconds(
        run({ a: node({ status: "success", duration: 2 }) }),
        now,
      ),
    ).toBeNull();
  });

  it("uses wall-clock partition throughput and waits for the first completed key", () => {
    const current = run(
      { a: node({ partitioned: true }) },
      {
        partitions: {
          started: ago(20),
          phase: "consumers",
          selected: 10,
          total: 100,
          completed: 3,
          failed: 1,
          not_started: 6,
          execution: { parallelism: 4, on_error: "continue" },
        },
      },
    );
    expect(remainingSeconds(current, now)).toBe(30);
    current.partitions!.completed = 0;
    current.partitions!.failed = 0;
    expect(remainingSeconds(current, now)).toBeNull();
    current.partitions!.phase = "values";
    expect(remainingSeconds(current, now)).toBeNull();
    delete current.partitions;
    expect(remainingSeconds(current, now)).toBeNull();
  });

  it("continues estimating downstream work after every partition settles", () => {
    expect(
      remainingSeconds(
        run(
          {
            partition: node({ partitioned: true, status: "success" }),
            collect: node({
              status: "running",
              started: ago(3),
              estimated_duration: 9,
            }),
          },
          {
            partitions: {
              selected: 4,
              total: 4,
              completed: 4,
              failed: 0,
              not_started: 0,
              phase: "consumers",
              execution: { parallelism: 2, on_error: "stop" },
            },
          },
        ),
        now,
      ),
    ).toBe(6);
  });

  it("tolerates unavailable timestamps and clocks ahead of the browser", () => {
    expect(
      remainingSeconds(
        run({
          a: node({
            status: "running",
            started: "invalid",
            estimated_duration: 3,
          }),
        }),
        now,
      ),
    ).toBe(3);
    expect(
      remainingSeconds(
        run({
          a: node({
            status: "running",
            started: ago(-5),
            estimated_duration: 3,
          }),
        }),
        now,
      ),
    ).toBe(3);
  });
});

it("formats approximate durations compactly without false precision", () => {
  expect([0.2, 1.1, 59.5, 61, 3599, 3660].map(remainingDuration)).toEqual([
    "1 s",
    "2 s",
    "1 min",
    "2 min",
    "1 h",
    "1 h 1 min",
  ]);
});
