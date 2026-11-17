import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyPython } from "./python-flow";

test("Python authoring, mixed SQL flow, lineage and artifacts", async ({
  page,
}) => {
  test.setTimeout(180000);
  await signIn(page);
  await verifyPython(page);
});
