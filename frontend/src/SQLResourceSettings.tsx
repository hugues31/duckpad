import { useSettingsForm } from "./useSettingsForm";
import { useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";

type Resources = { threads: number | null; memory_limit: string | null };
type Configuration = Resources & {
  automatic: { threads: number; memory_limit: string };
};

export default function SQLResourceSettings() {
  const t = useT();
  const settings = useApiResource<Configuration>("/sql-resources");
  const [draft, setConfig] = useState<Configuration | null>(null);
  const config = draft ?? settings.data;
  const [saved, setSaved] = useState(false);
  const { pending, run, ...save } = useAsyncAction();
  const error = save.error || settings.error;
  function change(values: Partial<Resources>) {
    setConfig(config && { ...config, ...values });
    setSaved(false);
  }
  const automatic = (value: string | number) =>
    t("automaticValue").replace("{value}", String(value));
  const persist = useSettingsForm({
    dirty: !!draft && JSON.stringify(draft) !== JSON.stringify(settings.data),
    discard: () => {
      setConfig(null);
    },
    save: async () => {
      if (!config) return;
      const { threads, memory_limit } = config;
      settings.setData(
        await api<Configuration>(
          "/sql-resources",
          send({ threads, memory_limit }, "PUT"),
        ),
      );
      setConfig(null);
      setSaved(true);
    },
  });
  return (
    <section className="settings-card" aria-label={t("sqlResources")}>
      <h2>{t("sqlResources")}</h2>
      <p className="muted">{t("sqlResourcesDescription")}</p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!config ? (
        <p>{t("loading")}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            void run(persist);
          }}
        >
          <fieldset disabled={pending} className="sql-resource-fields">
            <div className="settings-fields">
              <label className="field">
                <span>{t("sqlThreads")}</span>
                <input
                  type="number"
                  min={1}
                  max={1024}
                  step={1}
                  aria-label={t("sqlThreads")}
                  aria-describedby="sql-threads-hint"
                  placeholder={automatic(config.automatic.threads)}
                  value={config.threads ?? ""}
                  onChange={(e) =>
                    change({
                      threads:
                        e.target.value === "" ? null : e.target.valueAsNumber,
                    })
                  }
                />
                <small className="muted" id="sql-threads-hint">
                  {t("sqlThreadsHint").replace(
                    "{threads}",
                    String(config.automatic.threads),
                  )}
                </small>
              </label>
              <label className="field">
                <span>{t("sqlMemoryLimit")}</span>
                <input
                  maxLength={32}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t("sqlMemoryLimit")}
                  aria-describedby="sql-memory-hint"
                  placeholder={automatic(config.automatic.memory_limit)}
                  value={config.memory_limit ?? ""}
                  onChange={(e) => change({ memory_limit: e.target.value })}
                />
                <small className="muted" id="sql-memory-hint">
                  {t("sqlMemoryLimitHint").replace(
                    "{memory}",
                    config.automatic.memory_limit,
                  )}
                </small>
              </label>
            </div>
            <p className="muted">{t("sqlResourcesSharedHint")}</p>
            <p className="muted">{t("sqlResourcesApplyHint")}</p>
            <button className="button primary">
              {t(pending ? "saving" : "saveSqlResources")}
            </button>
          </fieldset>
          {saved && <p role="status">{t("sqlResourcesSaved")}</p>}
        </form>
      )}
    </section>
  );
}
