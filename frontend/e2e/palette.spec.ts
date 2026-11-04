import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyPalette } from "./palette-flow";

test("palette actions create and import reusable definitions without adding canvas nodes", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  await verifyPalette(page);
});
