import { expect, it } from "vitest";
import { ApiError } from "./api";
import type { Translate } from "./i18n";
import en from "./locales/en.json";
import { previewError } from "./previewError";

const t: Translate = (key) => en[key];

it("keeps structured missing inputs and diagnostics and distinguishes refusal reasons", () => {
  const missing = [{ input: "data", node: "source", port: "result" }];
  const result = previewError(
    new ApiError("Busy", 409, {
      code: "run_active",
      missing,
      diagnostic: { message: "line" },
    }),
    t,
  );
  expect(result.error).toBe(en.previewRunActive);
  expect(result.missing).toBe(missing);
  expect(result.diagnostic?.message).toBe("line");
  expect(
    previewError(new ApiError("Python", 409, { code: "python_preview" }), t)
      .error,
  ).toBe(en.previewPython);
  expect(
    previewError(
      new ApiError("Partitioned", 409, { code: "partitioned_preview" }),
      t,
    ).error,
  ).toBe(en.previewPartitioned);
  expect(previewError(new Error("Offline"), t).error).toBe(
    en.previewFailed.replace("{message}", "Offline"),
  );
});
