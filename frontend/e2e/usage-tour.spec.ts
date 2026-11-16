import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyUsageTour } from "./usage-tour-flow";

test("build a pipeline from scratch, inspect results and recover from invalid SQL", async ({
  page,
}) => {
  test.setTimeout(150000);
  await signIn(page);
  await verifyUsageTour(page);
});
