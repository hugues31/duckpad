import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
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

const kinds: ProviderKind[] = [
  "openai",
  "anthropic",
  "google",
  "mistral",
  "deepseek",
  "ollama",
  "custom",
];
const names = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  mistral: "Mistral",
  deepseek: "DeepSeek",
  ollama: "Ollama",
  custom: "OpenAI-compatible",
};

export default function AssistantSettings() {
  const t = useT();
  const explainError = useAssistantError();
  const providerName = (kind: ProviderKind) =>
    kind === "custom" ? t("assistantCustomProvider") : names[kind];
  const { refreshWorkspace } = useShell();
  const resource = useResource("/assistant/settings", (signal) =>
    api<Configuration>("/assistant/settings", { signal }),
  );
  const { data: config, setData: setConfig } = resource;
  const { pending, run, error } = useAsyncAction();
  const [saved, setSaved] = useState(false);
  const [tested, setTested] = useState(false);
  const [discovered, setDiscovered] = useState<Record<string, string[]>>({});
  const change = (values: Partial<Configuration>) => {
    setConfig((current) => current && { ...current, ...values });
    setSaved(false);
    setTested(false);
  };
  const providerChange = (id: string, values: Partial<AssistantProvider>) => {
    if (!config) return;
    change({
      providers: config.providers.map((p) =>
        p.id === id ? { ...p, ...values } : p,
      ),
    });
  };
  const persist = async () => {
    if (!config) return;
    const value = await api<Configuration>(
      "/assistant/settings",
      send(
        {
          ...config,
          providers: config.providers.map(({ has_key: _hasKey, ...p }) => p),
        },
        "PUT",
      ),
    );
    setConfig(value);
    setSaved(true);
    await refreshWorkspace();
  };
  return (
    <section className="settings-card" aria-label={t("assistant")}>
      <h2>{t("assistant")}</h2>
      <p className="muted">{t("assistantSettingsHint")}</p>
      {(error || resource.error) && (
        <div role="alert" className="notice error">
          {explainError(error || resource.error)}
        </div>
      )}
      {!config ? (
        <p>{t("loading")}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(persist);
          }}
        >
          <fieldset disabled={pending} className="assistant-settings-fields">
            <label className="check-row">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => change({ enabled: e.target.checked })}
              />
              {t("assistantEnabled")}
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={config.allow_data}
                onChange={(e) => change({ allow_data: e.target.checked })}
              />
              {t("assistantAllowData")}
            </label>
            <p className="muted">{t("assistantDataHint")}</p>
            <label className="field">
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
            {config.providers.map((provider, index) => (
              <fieldset key={provider.id} className="assistant-provider">
                <legend>
                  {t("assistantProvider")} {index + 1}
                </legend>
                <label className="field">
                  <span>{t("assistantProviderType")}</span>
                  <select
                    aria-label={t("assistantProviderType")}
                    value={provider.kind}
                    onChange={(e) => {
                      providerChange(provider.id, {
                        kind: e.target.value as ProviderKind,
                        base_url: "",
                        api_key: "",
                        has_key: false,
                        models: [],
                      });
                      setDiscovered((current) => ({
                        ...current,
                        [provider.id]: [],
                      }));
                    }}
                  >
                    {kinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {providerName(kind)}
                      </option>
                    ))}
                  </select>
                </label>
                {(provider.kind === "custom" || provider.kind === "ollama") && (
                  <label className="field">
                    <span>{t("assistantBaseUrl")}</span>
                    <input
                      type="url"
                      required={provider.kind === "custom"}
                      value={provider.base_url}
                      placeholder={
                        provider.kind === "ollama"
                          ? "http://localhost:11434/v1"
                          : "https://models.example.com/v1"
                      }
                      onChange={(e) =>
                        providerChange(provider.id, {
                          base_url: e.target.value,
                          api_key: "",
                          has_key: false,
                        })
                      }
                    />
                  </label>
                )}
                <label className="field">
                  <span>{t("assistantApiKey")}</span>
                  <input
                    type="password"
                    aria-label={t("assistantApiKey")}
                    autoComplete="new-password"
                    value={provider.api_key || ""}
                    onChange={(e) =>
                      providerChange(provider.id, { api_key: e.target.value })
                    }
                  />
                  <small className="muted">
                    {t(
                      provider.has_key
                        ? "assistantKeySaved"
                        : "assistantKeyHint",
                    )}
                  </small>
                </label>
                <label className="field">
                  <span>{t("assistantModels")}</span>
                  <textarea
                    aria-label={t("assistantModels")}
                    rows={3}
                    value={provider.models.join("\n")}
                    onChange={(e) =>
                      providerChange(provider.id, {
                        models: e.target.value.split("\n"),
                      })
                    }
                  />
                  <small className="muted">{t("assistantModelsHint")}</small>
                </label>
                <button
                  className="button secondary"
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      await persist();
                      const result = await api<{ models: string[] }>(
                        `/assistant/models/${provider.id}`,
                      );
                      setDiscovered((current) => ({
                        ...current,
                        [provider.id]: result.models,
                      }));
                    })
                  }
                >
                  {t("assistantDiscover")}
                </button>
                {discovered[provider.id] && (
                  <label className="field">
                    <span>{t("assistantAvailableModels")}</span>
                    <select
                      value=""
                      onChange={(e) => {
                        if (e.target.value)
                          providerChange(provider.id, {
                            models: [
                              ...new Set([
                                ...provider.models.filter(Boolean),
                                e.target.value,
                              ]),
                            ],
                          });
                      }}
                    >
                      <option value="">
                        {t(
                          discovered[provider.id].length
                            ? "assistantChooseModel"
                            : "assistantManualModels",
                        )}
                      </option>
                      {discovered[provider.id].map((model) => (
                        <option key={model}>{model}</option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  className="button secondary"
                  type="button"
                  onClick={() =>
                    change({
                      providers: config.providers.filter(
                        (p) => p.id !== provider.id,
                      ),
                    })
                  }
                >
                  <Trash2 size={14} />
                  {t("assistantRemoveProvider")}
                </button>
              </fieldset>
            ))}
            <button
              className="button secondary"
              type="button"
              onClick={() =>
                change({
                  providers: [
                    ...config.providers,
                    {
                      id: identifier("provider"),
                      kind: "openai",
                      base_url: "",
                      models: [],
                      api_key: "",
                    },
                  ],
                })
              }
            >
              <Plus size={14} />
              {t("assistantAddProvider")}
            </button>
            <label className="field">
              <span>{t("assistantDefaultModel")}</span>
              <select
                aria-label={t("assistantDefaultModel")}
                required={config.enabled}
                value={JSON.stringify([
                  config.default_provider,
                  config.default_model,
                ])}
                onChange={(e) => {
                  const [provider, model] = JSON.parse(
                    e.target.value,
                  ) as string[];
                  change({ default_provider: provider, default_model: model });
                }}
              >
                <option value={JSON.stringify(["", ""])}>
                  {t("assistantChooseModel")}
                </option>
                {config.providers.flatMap((p) =>
                  p.models.filter(Boolean).map((m) => (
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
            <div className="row gap">
              <button className="button primary">
                {t(pending ? "saving" : "save")}
              </button>
              <button
                className="button secondary"
                type="button"
                onClick={() =>
                  void run(async () => {
                    await persist();
                    await api("/assistant/test", send({}));
                    setTested(true);
                  })
                }
              >
                {t("assistantTest")}
              </button>
            </div>
          </fieldset>
          {saved && <p role="status">{t("assistantSaved")}</p>}
          {tested && <p role="status">{t("assistantTestSuccess")}</p>}
        </form>
      )}
    </section>
  );
}
