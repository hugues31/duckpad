import { useState } from "react";
import { ArrowRight, Database, Loader2 } from "lucide-react";
import { api, send } from "./api";
import DuckMark from "./DuckMark";
import { useT } from "./i18n";
import { PreferenceButtons, type Preferences } from "./preferences";
import { useAsyncAction } from "./useAsyncAction";

export default function LoginPage({
  preferences,
  onSuccess,
}: {
  preferences: Preferences;
  onSuccess: () => void;
}) {
  const t = useT();
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const { pending, error, run } = useAsyncAction();
  return (
    <div className="login-page">
      <div className="login-preferences">
        <PreferenceButtons preferences={preferences} />
      </div>
      <div className="login-brand">
        <DuckMark size={42} />
        <span>duckpad</span>
      </div>
      <section className="login-card">
        <span className="eyebrow">{t("localDataWorkspace")}</span>
        <h1>{t("signIn")}</h1>
        <p>{t("loginDescription")}</p>
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
        <p className="login-hint">{t("passwordHint")}</p>
      </section>
      <div className="login-footnote">
        <Database size={14} />
        <span>DuckDB + SQL + lineage</span>
      </div>
    </div>
  );
}
