import { useState, type FormEvent, type ReactNode } from "react";
import { Check, ExternalLink, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { PromptSettings } from "./AssistantPrompts";
import {
  ProviderLogo,
  keyPages,
  providerKinds,
  selfHosted,
  useProviderName,
} from "./assistantProviders";
import { useAssistantError } from "./assistantErrors";
import { api, send } from "./api";
import type {
  AssistantProvider,
  AssistantSettings as Configuration,
  ProviderKind,
} from "./assistantTypes";
import { identifier } from "./graph";
import { useT } from "./i18n";
import { useResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { useShell } from "./shell";

/** A provider as the server accepts it: with a key only when one was typed. */
const payload = ({ has_key: _hasKey, ...provider }: AssistantProvider) =>
  provider;

/** Keep the default model allowed, falling back to the first allowed model. */
function withDefault(config: Configuration): Configuration {
  const allowed = config.providers.flatMap((p) =>
    p.models.map((model) => [p.id, model]),
  );
  if (
    allowed.some(
      ([provider, model]) =>
        provider === config.default_provider && model === config.default_model,
    )
  )
    return config;
  const [provider = "", model = ""] = allowed[0] ?? [];
  return { ...config, default_provider: provider, default_model: model };
}

export default function AssistantSettings() {
  const t = useT();
  const explainError = useAssistantError();
  const providerName = useProviderName();
  const { refreshWorkspace } = useShell();
  const resource = useResource("/assistant/settings", (signal) =>
    api<Configuration>("/assistant/settings", { signal }),
  );
  // Edits stay local until saved; model discovery and the test use them as is.
  const [draft, setDraft] = useState<Configuration | null>(null);
  const config = draft ?? resource.data;
  const save = useAsyncAction();
  const check = useAsyncAction();
  const [saved, setSaved] = useState(false);
  const [tested, setTested] = useState("");
  const [picking, setPicking] = useState(false);
  const [added, setAdded] = useState("");
  const change = (values: Partial<Configuration>) => {
    if (!config) return;
    setDraft(withDefault({ ...config, ...values }));
    setSaved(false);
    setTested("");
    check.setError("");
  };
  const providerChange = (id: string, values: Partial<AssistantProvider>) =>
    config &&
    change({
      providers: config.providers.map((p) =>
        p.id === id ? { ...p, ...values } : p,
      ),
    });
  const addProvider = (kind: ProviderKind) => {
    if (!config) return;
    const id = identifier("provider");
    change({
      providers: [
        ...config.providers,
        { id, kind, base_url: "", models: [], api_key: "" },
      ],
    });
    setAdded(id);
    setPicking(false);
  };
  const discard = () => {
    setDraft(null);
    setTested("");
    check.setError("");
    save.setError("");
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!config) return;
    void save.run(async () => {
      const value = await api<Configuration>(
        "/assistant/settings",
        send({ ...config, providers: config.providers.map(payload) }, "PUT"),
      );
      resource.setData(value);
      setDraft(null);
      setSaved(true);
      await refreshWorkspace();
    });
  };
  const defaultProvider = config?.providers.find(
    (p) => p.id === config.default_provider,
  );
  const testConnection = () =>
    void check.run(async () => {
      if (!config || !defaultProvider) return;
      setTested("");
      await api(
        "/assistant/test",
        send({
          provider: payload(defaultProvider),
          model: config.default_model,
        }),
      );
      setTested(
        `${providerName(defaultProvider.kind)} · ${config.default_model}`,
      );
    });
  const enabled = resource.data?.enabled;
  const dirty =
    !!draft && JSON.stringify(draft) !== JSON.stringify(resource.data);
  return (
    <section
      className="settings-card assistant-settings"
      aria-label={t("assistant")}
    >
      <header className="assistant-settings-heading">
        <div>
          <h2>{t("assistant")}</h2>
          <p className="muted">{t("assistantSettingsHint")}</p>
        </div>
        {resource.data && (
          <span className={`badge ${enabled ? "success" : "neutral"}`}>
            {t(enabled ? "assistantStatusEnabled" : "assistantStatusDisabled")}
          </span>
        )}
      </header>
      {resource.error && (
        <div role="alert" className="notice error">
          {explainError(resource.error)}
        </div>
      )}
      {!config ? (
        <p>{t("loading")}</p>
      ) : (
        <form onSubmit={submit}>
          <fieldset
            disabled={save.pending}
            className="assistant-settings-fields"
          >
            <Step
              number={1}
              title={t("assistantStepProviders")}
              hint={t("assistantProvidersHint")}
            >
              {config.providers.map((provider) => (
                <ProviderCard
                  key={provider.id}
                  provider={provider}
                  autoFocus={provider.id === added}
                  onChange={(values) => providerChange(provider.id, values)}
                  onRemove={() =>
                    change({
                      providers: config.providers.filter(
                        (p) => p.id !== provider.id,
                      ),
                    })
                  }
                />
              ))}
              {picking || !config.providers.length ? (
                <ProviderPicker
                  onPick={addProvider}
                  onCancel={
                    config.providers.length
                      ? () => setPicking(false)
                      : undefined
                  }
                />
              ) : (
                <div>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setPicking(true)}
                  >
                    <Plus size={14} />
                    {t("assistantAddProvider")}
                  </button>
                </div>
              )}
            </Step>
            <Step
              number={2}
              title={t("assistantStepDefault")}
              hint={t("assistantDefaultHint")}
            >
              <label className="field">
                <span>{t("assistantDefaultModel")}</span>
                <select
                  aria-label={t("assistantDefaultModel")}
                  required={config.enabled}
                  disabled={!config.providers.some((p) => p.models.length)}
                  value={JSON.stringify([
                    config.default_provider,
                    config.default_model,
                  ])}
                  onChange={(e) => {
                    const [provider, model] = JSON.parse(
                      e.target.value,
                    ) as string[];
                    change({
                      default_provider: provider,
                      default_model: model,
                    });
                  }}
                >
                  <option value={JSON.stringify(["", ""])}>
                    {t(
                      config.providers.some((p) => p.models.length)
                        ? "assistantChooseModel"
                        : "assistantNoAllowedModels",
                    )}
                  </option>
                  {config.providers.flatMap((p) =>
                    p.models.map((m) => (
                      <option
                        key={`${p.id}/${m}`}
                        value={JSON.stringify([p.id, m])}
                      >
                        {providerName(p.kind)} · {m}
                      </option>
                    )),
                  )}
                </select>
              </label>
              <div className="assistant-inline-action">
                <button
                  className="button secondary"
                  type="button"
                  disabled={!defaultProvider || check.pending}
                  aria-describedby="assistant-test-hint"
                  onClick={testConnection}
                >
                  {t(check.pending ? "assistantTesting" : "assistantTest")}
                </button>
                <small className="muted" id="assistant-test-hint">
                  {t("assistantTestHint")}
                </small>
              </div>
              {check.error && (
                <div role="alert" className="notice error">
                  {explainError(check.error)}
                </div>
              )}
              {tested && (
                <p role="status" className="assistant-success">
                  <Check size={14} aria-hidden="true" />
                  {t("assistantTestSuccess").replace("{model}", tested)}
                </p>
              )}
            </Step>
            <Step number={3} title={t("assistantStepData")}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={config.allow_data}
                  onChange={(e) => change({ allow_data: e.target.checked })}
                />
                {t("assistantAllowData")}
              </label>
              <p className="muted">{t("assistantDataHint")}</p>
              <label className="field assistant-max-rows">
                <span>{t("assistantMaxRows")}</span>
                <input
                  type="number"
                  min={1}
                  max={500}
                  required
                  value={config.max_rows}
                  onChange={(e) => change({ max_rows: Number(e.target.value) })}
                />
              </label>
            </Step>
            <Step
              number={4}
              title={t("assistantQuickPrompts")}
              hint={t("assistantQuickPromptsHint")}
            >
              <PromptSettings
                value={config.quick_prompts ?? null}
                onChange={(quick_prompts) => change({ quick_prompts })}
              />
            </Step>
            <Step number={5} title={t("assistantStepEnable")}>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={config.enabled}
                  disabled={!config.enabled && !config.default_model}
                  aria-describedby="assistant-enable-hint"
                  onChange={(e) => change({ enabled: e.target.checked })}
                />
                {t("assistantEnabled")}
              </label>
              <p className="muted" id="assistant-enable-hint">
                {t(
                  config.enabled || config.default_model
                    ? "assistantEnabledHint"
                    : "assistantEnableNeedsModel",
                )}
              </p>
            </Step>
          </fieldset>
          <footer className="assistant-save-bar">
            {save.error && (
              <div role="alert" className="notice error">
                {explainError(save.error)}
              </div>
            )}
            <button
              className="button primary"
              disabled={!dirty || save.pending}
            >
              {t(save.pending ? "saving" : "save")}
            </button>
            {dirty && (
              <button
                className="button secondary"
                type="button"
                disabled={save.pending}
                onClick={discard}
              >
                {t("discardChanges")}
              </button>
            )}
            <span role="status">
              {dirty ? t("unsavedChanges") : saved ? t("assistantSaved") : ""}
            </span>
          </footer>
        </form>
      )}
    </section>
  );
}

function Step({
  number,
  title,
  hint,
  children,
}: {
  number: number;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="assistant-step">
      <h3>
        <span className="assistant-step-number" aria-hidden="true">
          {number}
        </span>
        {title}
      </h3>
      {hint && <p className="muted">{hint}</p>}
      {children}
    </section>
  );
}

function ProviderPicker({
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

function ProviderCard({
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
  const typed = !!provider.api_key?.trim();
  const keyPage = keyPages[provider.kind];
  const missing =
    !own && !typed && !provider.has_key
      ? "assistantDiscoverNeedsKey"
      : provider.kind === "custom" && !provider.base_url.trim()
        ? "assistantDiscoverNeedsUrl"
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
          <span className="badge pending">{t("assistantKeyUnsaved")}</span>
        ) : provider.has_key ? (
          <span className="badge success">
            <Check size={11} aria-hidden="true" />
            {t("assistantKeySavedBadge")}
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
                })
              }
            />
            <small className="muted" id={`${id}-url-hint`}>
              {t("assistantBaseUrlHint")}
            </small>
          </label>
        )}
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
