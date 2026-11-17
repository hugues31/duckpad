import { useEffect, useState } from "react";
import { useLocation } from "react-router";
import { ArrowRight, Check, Loader2, Plug, X } from "lucide-react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { LoginLayout } from "./LoginPage";
import type { Preferences } from "./preferences";
import { useAsyncAction } from "./useAsyncAction";

/** The app asking for access, as the server checked its authorization request. */
export interface AuthorizedClient {
  id: string;
  name: string;
  /** Identified by the HTTPS address of its metadata document, at `host`. */
  document: boolean;
  host: string | null;
  redirect_hosts: string[];
}

interface AuthorizationRequest {
  client: AuthorizedClient;
  redirect_host: string;
  /** The app returns to a loopback address: it runs on a computer. */
  local: boolean;
  account: string;
  scope: string;
}

type Checked = AuthorizationRequest | { redirect: string };

/** Leave Duckpad for the app; the consent page must not stay in the history. */
function returnTo(redirect: string, onLeave: (host: string) => void) {
  onLeave(new URL(redirect).host);
  window.location.replace(redirect);
}

/**
 * The OAuth authorization endpoint: a signed-in person allows an app such as
 * claude.ai or ChatGPT to use the agent tools with their account. The request
 * travels in the address; the server checks it again when the person decides.
 */
export default function AppAuthorization({
  preferences,
  onSignOut,
}: {
  preferences: Preferences;
  onSignOut: () => void;
}) {
  const t = useT();
  const { search } = useLocation();
  const query = search.replace(/^\?/, "");
  const [request, setRequest] = useState<AuthorizationRequest | null>(null);
  const [invalid, setInvalid] = useState("");
  const [leaving, setLeaving] = useState("");
  const action = useAsyncAction();
  useEffect(() => {
    let current = true;
    api<Checked>(`/oauth/authorization?${query}`).then(
      (checked) => {
        if (!current) return;
        // Invalid requests from a trusted app go back to it with an error.
        if ("redirect" in checked) returnTo(checked.redirect, setLeaving);
        else setRequest(checked);
      },
      (e: Error) => current && setInvalid(e.message),
    );
    return () => {
      current = false;
    };
  }, [query]);
  const decide = (approve: boolean) =>
    void action.run(async () => {
      const { redirect } = await api<{ redirect: string }>(
        "/oauth/authorization",
        send({ query, approve }),
      );
      returnTo(redirect, setLeaving);
    });
  const switchAccount = () =>
    void action.run(async () => {
      await api("/logout", send({}));
      onSignOut();
    });
  return (
    <LoginLayout preferences={preferences}>
      <span className="eyebrow">{t("authorizeAppEyebrow")}</span>
      {invalid ? (
        <>
          <h1>{t("authorizeAppInvalid")}</h1>
          <div className="notice error" role="alert">
            {invalid}
          </div>
          <p>{t("authorizeAppInvalidHint")}</p>
          <a className="button secondary full large" href="/projects">
            {t("authorizeAppOpenDuckpad")}
          </a>
        </>
      ) : leaving ? (
        <p className="app-authorization-status" role="status">
          <Loader2 size={17} className="spin" aria-hidden="true" />
          {t("authorizeAppReturning").replace("{host}", leaving)}
        </p>
      ) : !request ? (
        <p className="app-authorization-status" role="status">
          <Loader2 size={17} className="spin" aria-hidden="true" />
          {t("loading")}
        </p>
      ) : (
        <>
          <h1>
            {t("authorizeAppHeading").replace("{app}", request.client.name)}
          </h1>
          <p>{t("authorizeAppDescription")}</p>
          <div className="app-authorization-client">
            <span className="app-authorization-icon" aria-hidden="true">
              <Plug size={20} />
            </span>
            <span>
              <strong>{request.client.name}</strong>
              <small>
                {request.client.host
                  ? t("authorizeAppIdentified").replace(
                      "{host}",
                      request.client.host,
                    )
                  : t("authorizeAppSelfNamed")}
              </small>
            </span>
          </div>
          <dl className="app-authorization-facts">
            <div>
              <dt>{t("authorizeAppAccount")}</dt>
              <dd>
                <strong>{request.account}</strong>
                <button
                  type="button"
                  className="text-button"
                  disabled={action.pending}
                  onClick={switchAccount}
                >
                  {t("authorizeAppSwitchAccount")}
                </button>
              </dd>
            </div>
            <div>
              <dt>{t("authorizeAppReturnsTo")}</dt>
              <dd>
                <strong>{request.redirect_host}</strong>
              </dd>
            </div>
          </dl>
          {request.local && (
            <div className="notice warning">{t("authorizeAppLocal")}</div>
          )}
          <ul className="app-authorization-scope">
            {(
              [
                "authorizeAppCanRead",
                "authorizeAppCanEdit",
                "authorizeAppCanRequest",
              ] as const
            ).map((key) => (
              <li key={key}>
                <Check size={16} aria-hidden="true" />
                {t(key)}
              </li>
            ))}
            <li className="denied">
              <X size={16} aria-hidden="true" />
              {t("authorizeAppCannot")}
            </li>
          </ul>
          {action.error && (
            <div className="notice error" role="alert">
              {action.error}
            </div>
          )}
          <div className="app-authorization-actions">
            <button
              className="button primary full large"
              disabled={action.pending}
              onClick={() => decide(true)}
            >
              {action.pending ? (
                <Loader2 size={17} className="spin" />
              ) : (
                <ArrowRight size={17} />
              )}{" "}
              {t("authorizeAppAllow").replace("{app}", request.client.name)}
            </button>
            <button
              className="button secondary full large"
              disabled={action.pending}
              onClick={() => decide(false)}
            >
              {t("authorizeAppDeny")}
            </button>
          </div>
          <p className="login-hint">{t("authorizeAppRevokeHint")}</p>
        </>
      )}
    </LoginLayout>
  );
}
