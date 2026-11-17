import { useRef, useState } from "react";
import { api } from "./api";
import type { AuthorizedClient } from "./AppAuthorization";
import { useT } from "./i18n";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";

interface AuthorizedApp {
  id: string;
  client: AuthorizedClient;
  scope: string;
  created: number;
  last_used: number | null;
  expires: number;
}

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Apps that an account allowed to use the agent tools through OAuth, such as
 * claude.ai or ChatGPT connectors. Administrators see another account's apps
 * through `user`.
 */
export default function AuthorizedApps({ user }: { user?: string }) {
  const t = useT();
  const path = user ? `/users/${user}/oauth/apps` : "/oauth/apps";
  const resource = useApiResource<AuthorizedApp[]>(path);
  const action = useAsyncAction();
  const [revoke, setRevoke] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const addressField = useRef<HTMLInputElement>(null);
  const address = `${window.location.origin}/api/agent/mcp`;
  const insecure =
    window.location.protocol !== "https:" &&
    !LOOPBACK.includes(window.location.hostname);
  const error = action.error || resource.error;
  const date = (value: number) => new Date(value * 1000).toLocaleString();
  const copy = async () => {
    addressField.current?.select();
    // The clipboard API is unavailable on plain HTTP origins; the address stays selected.
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(address).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <section
      className="settings-card authorized-apps"
      aria-labelledby="authorized-apps-heading"
    >
      <h2 id="authorized-apps-heading">{t("authorizedApps")}</h2>
      <p className="muted">{t("authorizedAppsHint")}</p>
      {!user && (
        <div className="field">
          <label htmlFor="mcp-server-address">{t("mcpServerAddress")}</label>
          <div className="authorized-apps-address">
            <input
              id="mcp-server-address"
              ref={addressField}
              readOnly
              value={address}
              aria-describedby="mcp-server-address-hint"
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="button secondary"
              onClick={() => void copy()}
            >
              {t(copied ? "mcpServerAddressCopied" : "copyMcpServerAddress")}
            </button>
          </div>
          <small id="mcp-server-address-hint">
            {t("mcpServerAddressHint")}
          </small>
          {insecure && (
            <div className="notice warning">{t("authorizedAppsHttps")}</div>
          )}
        </div>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {resource.pending ? (
        <p>{t("loading")}</p>
      ) : (
        <div className="administration-table">
          <table>
            <thead>
              <tr>
                <th>{t("authorizedApp")}</th>
                <th>{t("authorizeAppReturnsTo")}</th>
                <th>{t("authorizedAppSince")}</th>
                <th>{t("apiTokenLastUsed")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {resource.data?.map((app) => (
                <tr key={app.id}>
                  <td>
                    <div className="authorized-app-name">
                      <strong>{app.client.name}</strong>
                      <small className="muted">
                        {app.client.host
                          ? t("authorizeAppIdentified").replace(
                              "{host}",
                              app.client.host,
                            )
                          : t("authorizeAppSelfNamed")}
                      </small>
                    </div>
                  </td>
                  <td>{app.client.redirect_hosts.join(", ")}</td>
                  <td>{date(app.created)}</td>
                  <td>
                    {app.last_used === null
                      ? t("apiTokenUnused")
                      : date(app.last_used)}
                  </td>
                  <td>
                    {revoke === app.id ? (
                      <>
                        <p>{t("revokeAuthorizedAppHint")}</p>
                        <button
                          className="text-button danger"
                          disabled={action.pending}
                          onClick={() =>
                            void action.run(async () => {
                              await api(`${path}/${app.id}`, {
                                method: "DELETE",
                              });
                              setRevoke(null);
                              resource.reload();
                            })
                          }
                        >
                          {t("confirm")}
                        </button>
                        <button
                          className="text-button"
                          disabled={action.pending}
                          onClick={() => setRevoke(null)}
                        >
                          {t("cancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        className="text-button danger"
                        disabled={action.pending}
                        onClick={() => setRevoke(app.id)}
                      >
                        {t("revokeApiToken")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!resource.data?.length && !resource.error && (
            <p className="muted">{t("noAuthorizedApps")}</p>
          )}
        </div>
      )}
    </section>
  );
}
