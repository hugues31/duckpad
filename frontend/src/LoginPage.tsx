import { useLocation, useNavigate } from "react-router";
import { SSO_RETURN_KEY } from "./navigation";
import { signInReturn } from "./routes";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, Database, Loader2 } from "lucide-react";
import { api, apiUrl, send } from "./api";
import DuckMark from "./DuckMark";
import { useT } from "./i18n";
import { PreferenceButtons, type Preferences } from "./preferences";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";

const SETUP_PREFIX = "#setup=";

/** The token of a first-launch setup link, which `duckpad start` opens as `/#setup=<token>`. */
function setupTokenFrom(hash: string) {
  return (
    (hash.startsWith(SETUP_PREFIX) && hash.slice(SETUP_PREFIX.length)) || null
  );
}

export default function LoginPage({
  preferences,
  onSuccess,
}: {
  preferences: Preferences;
  onSuccess: () => void;
}) {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  // Local sign-in remains available during discovery failures.
  const { data: provider } = useApiResource<{ label: string } | null>(
    "/oidc/provider",
  );
  const [ssoError] = useState(() =>
    new URLSearchParams(location.search).has("sso_error"),
  );
  const [setupToken, setSetupToken] = useState(() =>
    setupTokenFrom(location.hash),
  );
  useEffect(() => {
    if (new URLSearchParams(location.search).has("sso_error")) {
      const url = new URL(window.location.href);
      url.searchParams.delete("sso_error");
      void navigate(url.pathname + url.search + url.hash, { replace: true });
    }
  }, [location.search, navigate]);
  useEffect(() => {
    // Keep the setup token out of the address bar and the browser history.
    if (setupTokenFrom(location.hash))
      void navigate(location.pathname + location.search, { replace: true });
  }, [location.hash, location.pathname, location.search, navigate]);
  const { pending, error, run } = useAsyncAction();
  if (setupToken)
    return (
      <LoginLayout preferences={preferences}>
        <SetupForm
          token={setupToken}
          onSuccess={onSuccess}
          onSignIn={() => setSetupToken(null)}
        />
      </LoginLayout>
    );
  return (
    <LoginLayout preferences={preferences}>
      <span className="eyebrow">{t("localDataWorkspace")}</span>
      <h1>{t("signIn")}</h1>
      <p>{t("loginDescription")}</p>
      {ssoError && (
        <div className="notice error" role="alert">
          {t("ssoFailed")}
        </div>
      )}
      {provider && (
        <div className="sso-login">
          <a
            className="button secondary full large"
            href={apiUrl("/oidc/login")}
            onClick={() => {
              const target = signInReturn(location.pathname + location.search);
              if (target) sessionStorage.setItem(SSO_RETURN_KEY, target);
              else sessionStorage.removeItem(SSO_RETURN_KEY);
            }}
          >
            {t("ssoContinue")} {provider.label}
          </a>
          <p className="muted">{t("ssoLocalLogin")}</p>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/login", send({ username, password }));
            onSuccess();
          });
        }}
      >
        <label className="field">
          <span>{t("username")}</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
          />
        </label>
        <label className="field">
          <span>{t("password")}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
          />
        </label>
        {error && <div className="notice error">{error}</div>}
        <button className="button primary full large" disabled={pending}>
          {pending ? (
            <Loader2 size={17} className="spin" />
          ) : (
            <ArrowRight size={17} />
          )}{" "}
          {t("signInAction")}
        </button>
      </form>
      <p className="login-hint">{t("loginHint")}</p>
      {/* A failed attempt opens the recovery steps; the key applies the new default. */}
      <details
        key={error ? "failed" : "initial"}
        className="login-help"
        open={Boolean(error)}
      >
        <summary>{t("forgotPassword")}</summary>
        <p>{t("forgotPasswordAdmin")}</p>
        <p>{t("forgotPasswordSelf")}</p>
        <pre>
          <code>duckpad reset-password</code>
        </pre>
        <p>{t("forgotPasswordHome")}</p>
      </details>
    </LoginLayout>
  );
}

function LoginLayout({
  preferences,
  children,
}: {
  preferences: Preferences;
  children: ReactNode;
}) {
  return (
    <div className="login-page">
      <div className="login-preferences">
        <PreferenceButtons preferences={preferences} />
      </div>
      <div className="login-brand">
        <DuckMark size={42} />
        <span>duckpad</span>
      </div>
      <section className="login-card">{children}</section>
      <div className="login-footnote">
        <Database size={14} />
        <span>DuckDB + SQL + lineage</span>
      </div>
    </div>
  );
}

/** Choose the administrator's password from the link printed on the first launch. */
function SetupForm({
  token,
  onSuccess,
  onSignIn,
}: {
  token: string;
  onSuccess: () => void;
  onSignIn: () => void;
}) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const { pending, error, setError, run } = useAsyncAction();
  return (
    <>
      <span className="eyebrow">{t("setupEyebrow")}</span>
      <h1>{t("setupTitle")}</h1>
      <p>{t("setupDescription")}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password !== confirmation) {
            setError(t("passwordMismatch"));
            return;
          }
          void run(async () => {
            await api("/setup", send({ token, password }));
            onSuccess();
          });
        }}
      >
        {/* Lets password managers save the new password for the right account. */}
        <label className="field">
          <span>{t("username")}</span>
          <input value="admin" readOnly autoComplete="username" />
        </label>
        <label className="field">
          <span>{t("newPassword")}</span>
          <input
            aria-label={t("newPassword")}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={12}
            maxLength={1024}
            autoFocus
            autoComplete="new-password"
          />
          <small>{t("setupPasswordHint")}</small>
        </label>
        <label className="field">
          <span>{t("confirmPassword")}</span>
          <input
            type="password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            required
            autoComplete="new-password"
          />
        </label>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        <button className="button primary full large" disabled={pending}>
          {pending ? (
            <Loader2 size={17} className="spin" />
          ) : (
            <ArrowRight size={17} />
          )}{" "}
          {t("setupAction")}
        </button>
      </form>
      <button
        type="button"
        className="text-button login-switch"
        onClick={onSignIn}
      >
        {t("setupSignInInstead")}
      </button>
    </>
  );
}
