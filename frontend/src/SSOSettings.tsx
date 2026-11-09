import { useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import SettingsCard from "./SettingsCard";
import { useResource } from "./useApiResource";
import { useSettingsForm } from "./useSettingsForm";

type Configuration = {
  enabled: boolean;
  label: string;
  issuer: string;
  client_id: string;
  public_url: string;
  allow_signup: boolean;
  has_secret: boolean;
  redirect_uri: string;
};

export default function SSOSettings() {
  const t = useT();
  const resource = useResource("/sso", async (signal) => {
    const value = await api<Configuration>("/sso", { signal });
    return { ...value, public_url: value.public_url || location.origin };
  });
  const [secret, setSecret] = useState("");
  const {
    config,
    change,
    pending,
    saved,
    setSaved,
    submit,
    error: saveError,
  } = useSettingsForm(
    resource.data,
    async (config) => {
      const {
        has_secret: _hasSecret,
        redirect_uri: _redirect,
        ...settings
      } = config;
      const value = await api<Configuration>(
        "/sso",
        send({ ...settings, client_secret: secret || undefined }, "PUT"),
      );
      resource.setData(value);
      setSecret("");
    },
    { dirty: !!secret, discard: () => setSecret("") },
  );
  const error = saveError || resource.error;
  return (
    <SettingsCard
      title={t("ssoSettings")}
      description={t("ssoDescription")}
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
          <fieldset disabled={pending} className="sso-fields">
            <label className="check-row">
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => change({ enabled: e.target.checked })}
              />
              {t("ssoEnabled")}
            </label>
            <div className="settings-fields">
              <label className="field">
                <span>{t("ssoLabel")}</span>
                <input
                  required
                  maxLength={80}
                  value={config.label}
                  onChange={(e) => change({ label: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t("ssoIssuer")}</span>
                <input
                  type="url"
                  required={config.enabled}
                  placeholder="https://identity.example.com/realms/team"
                  value={config.issuer}
                  onChange={(e) => change({ issuer: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t("ssoClientId")}</span>
                <input
                  required={config.enabled}
                  autoComplete="off"
                  value={config.client_id}
                  onChange={(e) => change({ client_id: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t("ssoClientSecret")}</span>
                <input
                  type="password"
                  aria-label={t("ssoClientSecret")}
                  aria-describedby="sso-secret-hint"
                  autoComplete="new-password"
                  value={secret}
                  onChange={(e) => {
                    setSecret(e.target.value);
                    setSaved(false);
                  }}
                />
                <small className="muted" id="sso-secret-hint">
                  {t(
                    config.has_secret ? "ssoSecretSaved" : "ssoSecretRequired",
                  )}
                </small>
              </label>
              <label className="field">
                <span>{t("ssoPublicUrl")}</span>
                <input
                  type="url"
                  required={config.enabled}
                  value={config.public_url}
                  onChange={(e) => change({ public_url: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t("ssoCallback")}</span>
                <input
                  readOnly
                  aria-label={t("ssoCallback")}
                  aria-describedby="sso-callback-hint"
                  value={
                    config.public_url.trim().replace(/\/+$/, "") +
                    "/api/oidc/callback"
                  }
                  onFocus={(e) => e.target.select()}
                />
                <small className="muted" id="sso-callback-hint">
                  {t("ssoCallbackHint")}
                </small>
              </label>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={config.allow_signup}
                onChange={(e) => change({ allow_signup: e.target.checked })}
              />
              {t("ssoAllowSignup")}
            </label>
            <p className="muted">{t("ssoAccessHint")}</p>
            <button className="button primary">
              {t(pending ? "saving" : "save")}
            </button>
          </fieldset>
          {saved && <p role="status">{t("ssoSaved")}</p>}
        </form>
      )}
    </SettingsCard>
  );
}
