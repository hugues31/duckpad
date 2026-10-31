import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyNodeCode } from "./node-code-flow";

test("normal nodes own code, linked nodes share templates and conversions preserve copies", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  await verifyNodeCode(page);
});
