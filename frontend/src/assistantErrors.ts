import { useT, type TranslationKey } from "./i18n";

const errors: Record<string, TranslationKey> = {
  "The provider returned a response the assistant could not read. Check the server logs.":
    "assistantErrorResponse",
  "The provider refused the renewed OAuth2 token. Check the client permissions and scope.":
    "assistantErrorTokenAccess",
  "The provider returned a server error. Try again or ask an administrator to check the provider.":
    "assistantErrorServer",
  "The provider did not return a supported stream. Disable Streaming in its settings and try again.":
    "assistantErrorStreaming",
  "The OAuth2 token endpoint returned an invalid response. Check its configuration.":
    "assistantErrorTokenResponse",
  "Could not reach the OAuth2 token endpoint. Check its URL and connection.":
    "assistantErrorTokenNetwork",
  "The token endpoint refused the OAuth2 credentials. Check the client ID and secret.":
    "assistantErrorTokenRefused",
  "Provide a token URL, client ID and client secret for OAuth2":
    "assistantOAuthRequired",
  "Answer the pending run confirmation before sending another message":
    "assistantAnswerConfirmation",
  "This run request has already been answered": "assistantErrorApprovalUsed",
  "The run configuration changed. Request a new run and review its confirmation.":
    "assistantErrorRunChanged",
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
  "This conversation read content you can no longer open. Start a new conversation.":
    "assistantErrorLostAccess",
  "The assistant is disabled": "assistantErrorDisabled",
  "Choose an allowed assistant model": "assistantErrorChooseModel",
  "Provide an API key for this provider": "assistantErrorProvideKey",
  "The proposed changes are invalid": "assistantErrorInvalidEdit",
  "Resolve the pending project conflict before editing":
    "assistantErrorConflict",
  "Wait for the assistant response before undoing": "assistantErrorWait",
  "Open the conversation's original branch before undoing":
    "assistantErrorUndoBranch",
};

export function useAssistantError() {
  const t = useT();
  return (error: string) => (errors[error] ? t(errors[error]) : error);
}
