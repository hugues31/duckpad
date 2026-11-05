import { expect, it } from "vitest";
import { jobCron, jobInvocation, jobSlug } from "./jobs";

it("suggests a bounded API slug from a human name", () => {
  expect(jobSlug("  Daily Revenue / Production  ")).toBe(
    "daily-revenue-production",
  );
  expect(jobSlug("Annual R\u00e9venue")).toBe("annual-revenue");
  expect(jobSlug("a".repeat(79) + " b")).toBe("a".repeat(79));
  expect(jobSlug("!!!")).toBe("");
});

it("uses the public run API and CLI scheduler with credential placeholders", () => {
  expect(jobInvocation("daily-revenue")).toContain(
    "/api/v1/jobs/daily-revenue/runs",
  );
  expect(jobInvocation("daily-revenue")).toContain("--config -");
  expect(jobCron("daily-revenue")).toContain(
    "duckpad run daily-revenue --token-file",
  );
  expect(jobCron("daily-revenue")).toContain("0 2 * * *");
});
