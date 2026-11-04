import { useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import ExtensionImport from "./ExtensionImport";

type Configuration = { allow_unsigned_extensions: boolean };

export default function ExtensionSettings() {
  const t = useT();
  const settings = useApiResource<Configuration>("/extensions/settings");
  const { data: config, setData: setConfig } = settings;
  const [saved, setSaved] = useState(false);
  const { pending, run, ...save } = useAsyncAction();
  const error = save.error || settings.error;
  return (
    <section aria-label={t("extensionSettings")}>
      <h2>{t("extensionSettings")}</h2>
      <div className="settings-grid">
        <div className="settings-card">
          <ExtensionImport />
        </div>
        <div className="settings-card">
          <h3>{t("extensionUnsigned")}</h3>
          <p className="muted">{t("unsignedExtensionsHint")}</p>
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
                void run(async () => {
                  setConfig(
                    await api<Configuration>(
                      "/extensions/settings",
                      send(config, "PUT"),
                    ),
                  );
                  setSaved(true);
                });
              }}
            >
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={config.allow_unsigned_extensions}
                  disabled={pending}
                  onChange={(event) => {
                    setConfig({
                      allow_unsigned_extensions: event.target.checked,
                    });
                    setSaved(false);
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
        </div>
      </div>
    </section>
  );
}
