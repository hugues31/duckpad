import { api, send } from "./api";
import { useT } from "./i18n";
import SettingsCard from "./SettingsCard";
import { useApiResource } from "./useApiResource";
import { useSettingsForm } from "./useSettingsForm";

type Resources = { threads: number | null; memory_limit: string | null };
type Configuration = Resources & {
  automatic: { threads: number; memory_limit: string };
};

export default function SQLResourceSettings() {
  const t = useT();
  const settings = useApiResource<Configuration>("/sql-resources");
  const {
    config,
    change,
    pending,
    saved,
    submit,
    error: saveError,
  } = useSettingsForm(settings.data, async (config) => {
    settings.setData(
      await api<Configuration>(
        "/sql-resources",
        send(
          { threads: config.threads, memory_limit: config.memory_limit },
          "PUT",
        ),
      ),
    );
  });
  const error = saveError || settings.error;
  const automatic = (value: string | number) =>
    t("automaticValue").replace("{value}", String(value));
  return (
    <SettingsCard
      title={t("sqlResources")}
      description={t("sqlResourcesDescription")}
      error={error}
      loading={!config}
    >
      {config && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
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
                  onChange={(e) =>
                    change({ memory_limit: e.target.value || null })
                  }
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
    </SettingsCard>
  );
}
