import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyDataTests } from "./data-tests-flow";

test("normal node data tests warn, fail and pass with the results panel and run history", async ({
  page,
}) => {
  test.setTimeout(150000);
  await signIn(page);
  await verifyDataTests(page);
});
