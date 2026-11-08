import { api, send } from "./api";
import ExtensionImport from "./ExtensionImport";
import { useT } from "./i18n";
import SettingsCard from "./SettingsCard";
import { useApiResource } from "./useApiResource";
import { useSettingsForm } from "./useSettingsForm";

type Configuration = { allow_unsigned_extensions: boolean };

export default function ExtensionSettings() {
  const t = useT();
  const settings = useApiResource<Configuration>("/extensions/settings");
  const {
    config,
    change,
    pending,
    saved,
    submit,
    error: saveError,
  } = useSettingsForm(settings.data, async (config) => {
    settings.setData(
      await api<Configuration>("/extensions/settings", send(config, "PUT")),
    );
  });
  const error = saveError || settings.error;
  return (
    <section aria-label={t("extensionSettings")}>
      <h2>{t("extensionSettings")}</h2>
      <div className="settings-grid">
        <div className="settings-card">
          <ExtensionImport />
        </div>
        <SettingsCard
          title={t("extensionUnsigned")}
          description={t("unsignedExtensionsHint")}
          error={error}
          loading={!config}
          level={3}
        >
          {config && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={config.allow_unsigned_extensions}
                  disabled={pending}
                  onChange={(event) => {
                    change({
                      allow_unsigned_extensions: event.target.checked,
                    });
                  }}
                />
                {t("allowUnsignedExtensions")}
              </label>
              <p className="muted">{t("extensionSettingsApplyHint")}</p>
              <button className="button primary" disabled={pending}>
                {t("saveExtensionSettings")}
              </button>
              {saved && <p role="status">{t("extensionSettingsSaved")}</p>}
            </form>
          )}
        </SettingsCard>
      </div>
    </section>
  );
}
