import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyDataPreparation } from "./data-preparation-flow";

test.use({ actionTimeout: 10000 });

test("clean, select, reorder and type columns through forms; restore saved settings and reject invalid conversions", async ({
  page,
}) => {
  test.setTimeout(120000);
  await signIn(page);
  await verifyDataPreparation(page);
});
