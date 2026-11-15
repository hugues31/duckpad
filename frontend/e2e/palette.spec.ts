import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyPalette } from "./palette-flow";

for (const language of ["sql", "python"] as const) {
  test(`palette actions create and import reusable ${language} definitions without adding canvas nodes`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    await signIn(page);
    await verifyPalette(page, language);
  });
}
