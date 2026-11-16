import { Check, ExternalLink, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useState } from "react";
import { api, send } from "./api";
import { useAssistantError } from "./assistantErrors";
import {
  ProviderLogo,
  keyPages,
  providerKinds,
  selfHosted,
  useProviderName,
} from "./assistantProviders";
import type { AssistantProvider, ProviderKind } from "./assistantTypes";
import { useT } from "./i18n";
import { useAsyncAction } from "./useAsyncAction";

/** Credentials are sent only when typed; saved values stay on the server. */
export const payload = ({
  has_key: _hasKey,
  has_secret: _hasSecret,
  ...provider
}: AssistantProvider) => provider;

export function ProviderPicker({
  onPick,
  onCancel,
}: {
  onPick: (kind: ProviderKind) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const providerName = useProviderName();
  return (
    <div
      className="assistant-provider-picker"
      role="group"
      aria-labelledby="assistant-provider-picker"
    >
      <div className="assistant-provider-picker-heading">
        <h4 id="assistant-provider-picker">{t("assistantChooseProvider")}</h4>
        {onCancel && (
          <button
            className="button secondary small"
            type="button"
            onClick={onCancel}
          >
            {t("cancel")}
          </button>
        )}
      </div>
      <div className="assistant-provider-choices">
        {providerKinds.map((kind) => (
          <button
            key={kind}
            type="button"
            className="assistant-provider-choice"
            onClick={() => onPick(kind)}
          >
            <span className="assistant-provider-logo">
              <ProviderLogo kind={kind} />
            </span>
            {providerName(kind)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ProviderCard({
  provider,
  autoFocus,
  onChange,
  onRemove,
}: {
  provider: AssistantProvider;
  autoFocus: boolean;
  onChange: (values: Partial<AssistantProvider>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const explainError = useAssistantError();
  const providerName = useProviderName();
  const discovery = useAsyncAction();
  const [catalog, setCatalog] = useState<{
    models: string[];
    listed: boolean;
  } | null>(null);
  const [filter, setFilter] = useState("");
  const [manual, setManual] = useState("");
  const id = `assistant-provider-${provider.id}`;
  const own = selfHosted(provider.kind);
  const oauth = provider.kind === "custom" && provider.auth === "oauth2";
  const typed = oauth ? !!provider.client_secret : !!provider.api_key?.trim();
  const hasCredential = oauth ? provider.has_secret : provider.has_key;
  const keyPage = keyPages[provider.kind];
  const missing =
    !own && !typed && !hasCredential
      ? "assistantDiscoverNeedsKey"
      : provider.kind === "custom" && !provider.base_url.trim()
        ? "assistantDiscoverNeedsUrl"
        : oauth &&
            (!provider.token_url?.trim() ||
              !provider.client_id?.trim() ||
              (!typed && !hasCredential))
          ? "assistantOAuthRequired"
          : null;
  const select = (model: string, on: boolean) =>
    onChange({
      models: on
        ? [...provider.models, model]
        : provider.models.filter((m) => m !== model),
    });
  const addManual = () => {
    const model = manual.trim();
    if (model && !provider.models.includes(model)) select(model, true);
    setManual("");
  };
  const discover = () =>
    void discovery.run(async () => {
      setCatalog(null);
      setCatalog(
        await api<{ models: string[]; listed: boolean }>(
          "/assistant/models",
          send(payload(provider)),
        ),
      );
    });
  const query = filter.trim().toLowerCase();
  const shown =
    catalog?.models.filter((m) => m.toLowerCase().includes(query)) ?? [];
  return (
    <div
      className="assistant-provider"
      role="group"
      aria-labelledby={`${id}-name`}
    >
      <header className="assistant-provider-heading">
        <span className="assistant-provider-logo">
          <ProviderLogo kind={provider.kind} size={22} />
        </span>
        <h4 id={`${id}-name`}>{providerName(provider.kind)}</h4>
        {typed ? (
          <span className="badge pending">
            {t(oauth ? "assistantSecretUnsaved" : "assistantKeyUnsaved")}
          </span>
        ) : hasCredential ? (
          <span className="badge success">
            <Check size={11} aria-hidden="true" />
            {t(oauth ? "assistantSecretSavedBadge" : "assistantKeySavedBadge")}
          </span>
        ) : (
          !own && (
            <span className="badge stale">{t("assistantKeyMissing")}</span>
          )
        )}
        <button
          type="button"
          className="icon assistant-provider-remove"
          aria-label={t("assistantRemoveProvider")}
          data-tooltip={t("assistantRemoveProvider")}
          onClick={onRemove}
        >
          <Trash2 size={15} />
        </button>
      </header>
      <div className="assistant-provider-fields">
        {own && (
          <label className="field">
            <span>{t("assistantBaseUrl")}</span>
            <input
              type="url"
              aria-label={t("assistantBaseUrl")}
              aria-describedby={`${id}-url-hint`}
              autoFocus={autoFocus}
              required={provider.kind === "custom"}
              value={provider.base_url}
              placeholder={
                provider.kind === "ollama"
                  ? "http://localhost:11434/v1"
                  : "https://models.example.com/v1"
              }
              onChange={(e) =>
                onChange({
                  base_url: e.target.value,
                  api_key: "",
                  has_key: false,
                  client_secret: "",
                  has_secret: false,
                })
              }
            />
            <small className="muted" id={`${id}-url-hint`}>
              {t("assistantBaseUrlHint")}
            </small>
          </label>
        )}
        {provider.kind === "custom" && (
          <label className="field">
            <span>{t("assistantAuthentication")}</span>
            <select
              aria-label={t("assistantAuthentication")}
              value={provider.auth ?? "api_key"}
              onChange={(e) =>
                // Saved credentials stay until a save with the other method clears them.
                onChange({
                  auth: e.target.value as "api_key" | "oauth2",
                  api_key: "",
                  client_secret: "",
                })
              }
            >
              <option value="api_key">{t("assistantApiKey")}</option>
              <option value="oauth2">{t("assistantOAuth")}</option>
            </select>
          </label>
        )}
        {oauth ? (
          <>
            <label className="field">
              <span>{t("assistantTokenUrl")}</span>
              <input
                type="url"
                aria-label={t("assistantTokenUrl")}
                required
                value={provider.token_url ?? ""}
                placeholder="https://auth.example.com/oauth/token"
                onChange={(e) =>
                  onChange({
                    token_url: e.target.value,
                    client_secret: "",
                    has_secret: false,
                  })
                }
              />
            </label>
            <label className="field">
              <span>{t("assistantClientId")}</span>
              <input
                aria-label={t("assistantClientId")}
                required
                autoComplete="off"
                value={provider.client_id ?? ""}
                onChange={(e) =>
                  onChange({
                    client_id: e.target.value,
                    client_secret: "",
                    has_secret: false,
                  })
                }
              />
            </label>
            <label className="field">
              <span>{t("assistantClientSecret")}</span>
              <input
                type="password"
                aria-label={t("assistantClientSecret")}
                aria-describedby={`${id}-secret-hint`}
                autoComplete="new-password"
                required={!provider.has_secret}
                placeholder={
                  provider.has_secret
                    ? t("assistantKeyPlaceholderSaved")
                    : undefined
                }
                value={provider.client_secret ?? ""}
                onChange={(e) => onChange({ client_secret: e.target.value })}
              />
              <small className="muted" id={`${id}-secret-hint`}>
                {t("assistantSecretHint")}
              </small>
            </label>
            <label className="field">
              <span>{t("assistantScope")}</span>
              <input
                aria-label={t("assistantScope")}
                value={provider.scope ?? ""}
                onChange={(e) => onChange({ scope: e.target.value })}
              />
            </label>
          </>
        ) : (
          <label className="field">
            <span>{t("assistantApiKey")}</span>
            <input
              type="password"
              aria-label={t("assistantApiKey")}
              aria-describedby={`${id}-key-hint`}
              autoComplete="new-password"
              autoFocus={autoFocus && !own}
              placeholder={
                provider.has_key ? t("assistantKeyPlaceholderSaved") : undefined
              }
              value={provider.api_key || ""}
              onChange={(e) => onChange({ api_key: e.target.value })}
            />
            <small className="muted" id={`${id}-key-hint`}>
              {t(
                provider.has_key
                  ? "assistantKeySaved"
                  : own
                    ? "assistantKeyHint"
                    : "assistantKeyRequired",
              )}
              {keyPage && (
                <>
                  {" "}
                  <a href={keyPage} target="_blank" rel="noreferrer">
                    {t("assistantCreateKey")}
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                </>
              )}
            </small>
          </label>
        )}
        {provider.kind === "custom" && (
          <div>
            <label className="check-row">
              <input
                type="checkbox"
                aria-label={t("assistantStreaming")}
                aria-describedby={`${id}-streaming-hint`}
                checked={provider.streaming !== false}
                onChange={(e) => onChange({ streaming: e.target.checked })}
              />
              <span>{t("assistantStreaming")}</span>
            </label>
            <small className="muted" id={`${id}-streaming-hint`}>
              {t("assistantStreamingHint")}
            </small>
          </div>
        )}
      </div>
      <div
        className="assistant-models"
        role="group"
        aria-labelledby={`${id}-models`}
      >
        <span className="assistant-models-label" id={`${id}-models`}>
          {t("assistantModels")}
        </span>
        {provider.models.length ? (
          <ul className="assistant-model-chips">
            {provider.models.map((model) => (
              <li key={model}>
                <span>{model}</span>
                <button
                  type="button"
                  aria-label={t("assistantRemoveModel").replace(
                    "{model}",
                    model,
                  )}
                  onClick={() => select(model, false)}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">{t("assistantNoModels")}</p>
        )}
        <div className="assistant-inline-action">
          <button
            className="button secondary small"
            type="button"
            disabled={!!missing || discovery.pending}
            onClick={discover}
          >
            <RefreshCw
              size={13}
              aria-hidden="true"
              className={discovery.pending ? "spin" : undefined}
            />
            {t(
              discovery.pending ? "assistantDiscovering" : "assistantDiscover",
            )}
          </button>
          {missing && <small className="muted">{t(missing)}</small>}
        </div>
        {discovery.error && (
          <div role="alert" className="notice error">
            {explainError(discovery.error)}
          </div>
        )}
        {catalog && (
          <p role="status" className="muted">
            {!catalog.listed
              ? t("assistantModelsNotListed")
              : catalog.models.length
                ? t("assistantModelsFound").replace(
                    "{count}",
                    String(catalog.models.length),
                  )
                : t("assistantModelsEmpty")}
          </p>
        )}
        {!!catalog?.models.length && (
          <div className="assistant-catalog">
            {catalog.models.length > 8 && (
              <input
                type="search"
                aria-label={t("assistantFilterModels")}
                placeholder={t("assistantFilterModels")}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
              />
            )}
            <div
              className="assistant-catalog-list"
              role="group"
              aria-label={t("assistantAvailableModels")}
            >
              {shown.map((model) => (
                <label key={model} className="check-row">
                  <input
                    type="checkbox"
                    checked={provider.models.includes(model)}
                    onChange={(e) => select(model, e.target.checked)}
                  />
                  {model}
                </label>
              ))}
              {!shown.length && (
                <p className="muted">{t("assistantNoMatchingModels")}</p>
              )}
            </div>
          </div>
        )}
        <div className="assistant-manual-model">
          <input
            aria-label={t("assistantAddModel")}
            placeholder={t("assistantAddModel")}
            maxLength={200}
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              addManual();
            }}
          />
          <button
            className="button secondary small"
            type="button"
            disabled={!manual.trim()}
            onClick={addManual}
          >
            <Plus size={13} />
            {t("assistantAddModelButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
