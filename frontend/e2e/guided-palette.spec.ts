import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyGuidedPalette } from "./guided-palette-flow";

test.use({ actionTimeout: 10000 });

test("load, join, filter, aggregate and download Parquet using public parameter forms", async ({
  page,
}) => {
  test.setTimeout(180000);
  await signIn(page);
  await verifyGuidedPalette(page);
});
