import { test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyMessages } from "./messages-flow";

test("normal node messages appear on the canvas, inspector and history and errors block descendants", async ({
  page,
}) => {
  test.setTimeout(120000);
  await signIn(page);
  await verifyMessages(page);
});
