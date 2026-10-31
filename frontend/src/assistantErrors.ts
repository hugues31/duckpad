import { useT, type TranslationKey } from "./i18n";

const errors: Record<string, TranslationKey> = {
  "The provider refused the API key. Ask an instance administrator to check it.":
    "assistantErrorKey",
  "The provider quota or rate limit was reached. Try again later.":
    "assistantErrorQuota",
  "The model is unavailable or does not support this request. Check the configured model.":
    "assistantErrorModel",
  "Could not reach the assistant provider. Check the connection and model, then try again.":
    "assistantErrorNetwork",
  "The assistant timed out. Try a narrower question.": "assistantErrorTimeout",
  "The assistant reached its limit for this turn. Try a narrower question.":
    "assistantErrorLimit",
  "Data reading is now disabled. Start a new conversation to keep previous values private.":
    "assistantErrorPolicy",
  "Assistant settings changed. Start a new turn.": "assistantErrorChanged",
  "The assistant is disabled": "assistantErrorDisabled",
  "Choose an allowed assistant model": "assistantErrorChooseModel",
  "Provide an API key for this provider": "assistantErrorProvideKey",
};

export function useAssistantError() {
  const t = useT();
  return (error: string) => (errors[error] ? t(errors[error]) : error);
}
