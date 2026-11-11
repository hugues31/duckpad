import { describe, expect, it } from "vitest";
import {
  elapsedDuration,
  nodeProgress,
  overran,
  progressTimeline,
  remainingDuration,
  remainingSeconds,
} from "./runEstimate";
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
    for (const status of ["preparing", "canceling"] as const)
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

describe("nodeProgress", () => {
  it("follows a node through the active run only", () => {
    const current = run({
      waiting: node({ estimated_duration: 5 }),
      active: node({
        status: "running",
        started: ago(4),
        estimated_duration: 10,
      }),
      finished: node({ status: "success", duration: 2 }),
      failed: node({ status: "failed" }),
    });
    expect(nodeProgress(current, "waiting")).toMatchObject({
      phase: "queued",
      total: 5,
      started: undefined,
    });
    expect(nodeProgress(current, "active")).toEqual({
      phase: "running",
      started: now - 4000,
      total: 10,
      done: 0,
      running: [{ started: now - 4000, estimate: 10 }],
    });
    expect(nodeProgress(current, "finished")?.phase).toBe("done");
    // Failures keep their own status; nodes outside the scope have no progress.
    expect(nodeProgress(current, "failed")).toBeUndefined();
    expect(nodeProgress(current, "elsewhere")).toBeUndefined();
    expect(nodeProgress({ ...current, status: "success" }, "active")).toBe(
      undefined,
    );
    expect(nodeProgress(null, "active")).toBeUndefined();
    expect(
      nodeProgress({ ...current, status: "canceling" }, "active")?.paused,
    ).toBe(true);
  });

  it("combines the nodes of a component and stays unknown without every estimate", () => {
    const nested = {
      box: node({ status: "pending" }),
      "box::a": node({ status: "success", started: ago(8), duration: 6 }),
      "box::b": node({
        status: "running",
        started: ago(2),
        estimated_duration: 4,
      }),
      "box::c": node({ estimated_duration: 10 }),
      boxed: node({ status: "running", started: ago(1) }),
    };
    // The instance itself has no previous duration, so the total is unknown.
    expect(nodeProgress(run(nested), "box")).toMatchObject({
      phase: "running",
      started: now - 8000,
      total: undefined,
      running: [],
    });
    const { box: _, ...children } = nested;
    expect(nodeProgress(run(children), "box")).toEqual({
      phase: "running",
      started: now - 8000,
      total: 20,
      done: 6,
      running: [{ started: now - 2000, estimate: 4 }],
    });
    // Between two of its nodes, the component keeps the progress it reached.
    const waiting = nodeProgress(
      run({
        ...children,
        "box::b": node({ status: "success", started: ago(2), duration: 1 }),
      }),
      "box",
    )!;
    expect(waiting).toEqual({
      phase: "running",
      started: now - 8000,
      total: 17,
      done: 7,
      running: [],
    });
    expect(progressTimeline(waiting, now)).toEqual({
      duration: 0,
      frames: [{ offset: 0, share: 7 / 17 }],
    });
    expect(overran(waiting, now + 60_000)).toBe(false);
    // A failed or blocked node shows through, whatever is left to run.
    for (const status of ["failed", "blocked"] as const)
      expect(
        nodeProgress(run({ ...children, "box::a": node({ status }) }), "box"),
      ).toBeUndefined();
    expect(
      nodeProgress(
        run({
          part: node({
            status: "running",
            started: ago(1),
            partitioned: true,
            estimated_duration: 3,
          }),
        }),
        "part",
      )?.total,
    ).toBeUndefined();
  });

  it("shows partitioned nodes in progress while their keys execute", () => {
    const partitioned = (partitions: Partial<NonNullable<Run["partitions"]>>) =>
      nodeProgress(
        {
          ...run({
            zone: node({ partitioned: true, estimated_duration: 3 }),
          }),
          partitions: {
            total: 4,
            selected: 4,
            completed: 0,
            failed: 0,
            not_started: 4,
            phase: "consumers",
            started: ago(9),
            execution: { parallelism: 1, on_error: "continue" },
            ...partitions,
          },
        },
        "zone",
      );
    // Its own state stays pending until the run ends.
    expect(partitioned({})?.phase).toBe("queued");
    expect(partitioned({ active: ["first"] })).toEqual({
      phase: "running",
      started: now - 9000,
      total: undefined,
      done: 0,
      running: [],
    });
    // Between two keys, and until the last one settles.
    expect(partitioned({ completed: 1, active: [] })?.phase).toBe("running");
    expect(partitioned({ completed: 4 })?.phase).toBe("done");
    expect(partitioned({ completed: 3, failed: 1 })).toBeUndefined();
  });
});

describe("progressTimeline", () => {
  it("animates the expected share until every running node reaches its estimate", () => {
    const progress = nodeProgress(
      run({
        "c::done": node({ status: "success", duration: 2 }),
        "c::short": node({
          status: "running",
          started: ago(1),
          estimated_duration: 3,
        }),
        "c::long": node({
          status: "running",
          started: ago(2),
          estimated_duration: 6,
        }),
        "c::next": node({ estimated_duration: 4 }),
      }),
      "c",
    )!;
    // 2 s done + 1 s + 2 s elapsed, of 15 s expected.
    expect(progressTimeline(progress, now)).toEqual({
      duration: 4000,
      frames: [
        { offset: 0, share: 5 / 15 },
        { offset: 0.5, share: 9 / 15 },
        { offset: 1, share: 11 / 15 },
      ],
    });
    expect(overran(progress, now)).toBe(false);
    expect(overran(progress, now + 3000)).toBe(false);
    expect(overran(progress, now + 4000)).toBe(true);
    // Past every estimate, the fill holds and only the activity sweep moves.
    expect(progressTimeline(progress, now + 9000)).toEqual({
      duration: 0,
      frames: [{ offset: 0, share: 11 / 15 }],
    });
  });

  it("has no timeline without an estimate or outside execution", () => {
    const unknown = nodeProgress(
      run({ a: node({ status: "running", started: ago(1) }) }),
      "a",
    )!;
    expect(progressTimeline(unknown, now)).toBeNull();
    expect(overran(unknown, now + 60_000)).toBe(false);
    const queued = nodeProgress(
      run({ a: node({ estimated_duration: 2 }) }),
      "a",
    )!;
    expect(progressTimeline(queued, now)).toBeNull();
  });
});

it("formats ticking elapsed time in whole seconds", () => {
  expect(
    [-1, 0.9, 59.9, 60, 65, 3599, 3600, 3720].map(elapsedDuration),
  ).toEqual([
    "0 s",
    "0 s",
    "59 s",
    "1 min",
    "1 min 5 s",
    "59 min 59 s",
    "1 h",
    "1 h 2 min",
  ]);
});
