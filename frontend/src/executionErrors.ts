import type { Translate } from "./i18n";

/** Explain Python policy refusals while preserving other execution diagnostics. */
export function executionErrorMessage(message: string, t: Translate) {
  return message === "Python execution is disabled" ||
    message ===
      "Python execution is disabled; ask an instance administrator to enable it"
    ? t("pythonExecutionDisabled")
    : message;
}
