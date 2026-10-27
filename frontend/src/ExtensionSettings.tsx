import { useEffect, useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { useAsyncAction } from "./useAsyncAction";

type Configuration = { allow_unsigned_extensions: boolean };

export default function ExtensionSettings() {
  const t = useT();
  const [config, setConfig] = useState<Configuration | null>(null);
  const [saved, setSaved] = useState(false);
  const { pending, error, setError, run } = useAsyncAction();
  useEffect(() => {
    let live = true;
    api<Configuration>("/extensions/settings")
      .then((value) => {
        if (live) setConfig(value);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [setError]);
  return (
    <section className="settings-card" aria-label={t("extensionSettings")}>
      <h2>{t("extensionSettings")}</h2>
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
                setConfig({ allow_unsigned_extensions: event.target.checked });
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
    </section>
  );
}
