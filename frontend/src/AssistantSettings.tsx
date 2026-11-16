import { Check, Plus } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { api, send } from "./api";
import { useAssistantError } from "./assistantErrors";
import { PromptSettings } from "./AssistantPrompts";
import { useProviderName } from "./assistantProviders";
import {
  payload,
  ProviderCard,
  ProviderPicker,
} from "./AssistantProviderSettings";
import type {
  AssistantProvider,
  AssistantSettings as Configuration,
  ProviderKind,
} from "./assistantTypes";
import { identifier } from "./graph";
import { useT } from "./i18n";
import { useShell } from "./shell";
import { useResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { useSettingsGuard } from "./useSettingsForm";

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
  const dirty =
    !!draft && JSON.stringify(draft) !== JSON.stringify(resource.data);
  const persist = useSettingsGuard({
    dirty,
    discard,
    save: async () => {
      if (!config) return;
      const value = await api<Configuration>(
        "/assistant/settings",
        send({ ...config, providers: config.providers.map(payload) }, "PUT"),
      );
      resource.setData(value);
      setDraft(null);
      setSaved(true);
      await refreshWorkspace();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save.run(persist);
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
