import { useEffect, useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { useAsyncAction } from "./useAsyncAction";

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
  const [config, setConfig] = useState<Configuration | null>(null);
  const [secret, setSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const { pending, error, setError, run } = useAsyncAction();
  useEffect(() => {
    let live = true;
    api<Configuration>("/sso")
      .then((value) => {
        if (live)
          setConfig({
            ...value,
            public_url: value.public_url || location.origin,
          });
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [setError]);
  function change(values: Partial<Configuration>) {
    setConfig((current) => current && { ...current, ...values });
    setSaved(false);
  }
  return (
    <section className="settings-card" aria-label={t("ssoSettings")}>
      <h2>{t("ssoSettings")}</h2>
      <p className="muted">{t("ssoDescription")}</p>
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
              const {
                has_secret: _hasSecret,
                redirect_uri: _redirect,
                ...settings
              } = config;
              const value = await api<Configuration>(
                "/sso",
                send(
                  { ...settings, client_secret: secret || undefined },
                  "PUT",
                ),
              );
              setConfig(value);
              setSecret("");
              setSaved(true);
            });
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
                {t(config.has_secret ? "ssoSecretSaved" : "ssoSecretRequired")}
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
    </section>
  );
}
