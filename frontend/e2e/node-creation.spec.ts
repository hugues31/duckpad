import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyNodeCreation } from "./node-creation-flow";

test("node creation defers validation, shares node actions and keeps palette labels readable", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  await verifyNodeCreation(page);
});
