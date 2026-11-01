import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { jobsFlow } from "./jobs-flow";

test("admins create and promote tagged Jobs; Operators confirm production runs and inspect read-only results", async ({
  page,
}) => {
  await signIn(page);
  await jobsFlow(page);
});
