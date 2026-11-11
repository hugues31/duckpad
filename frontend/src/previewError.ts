import { errorDetail } from "./api";
import type { MissingInput } from "./draftPreview";
import type { Translate } from "./i18n";
import type { SqlDiagnostic } from "./types";
export function previewError(error: unknown, t: Translate) {
  const detail = errorDetail(error);
  return {
    error: t(
      detail.code === "run_active"
        ? "previewRunActive"
        : detail.code === "python_preview"
          ? "previewPython"
          : detail.code === "partitioned_preview"
            ? "previewPartitioned"
            : "previewFailed",
    ).replace("{message}", (error as Error).message),
    missing: detail.missing as MissingInput[] | undefined,
    diagnostic: detail.diagnostic as SqlDiagnostic | undefined,
  };
}
