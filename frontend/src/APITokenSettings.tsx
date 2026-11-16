import { useRef, useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";

interface APIToken {
  id: string;
  name: string;
  created: number;
  expires: number | null;
  last_used: number | null;
}

/** Secrets are kept only in this mounted view, never in the token list or preferences. */
export default function APITokenSettings({
  user,
  canCreate = true,
}: {
  user?: string;
  canCreate?: boolean;
}) {
  const t = useT();
  const path = user ? `/users/${user}/api-tokens` : "/api-tokens";
  const resource = useApiResource<APIToken[]>(path);
  const action = useAsyncAction();
  const secretField = useRef<HTMLInputElement>(null);
  const [created, setCreated] = useState<(APIToken & { token: string }) | null>(
    null,
  );
  const [revoke, setRevoke] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [suggestedExpiry] = useState(() =>
    new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
  );
  const error = action.error || resource.error;
  const date = (value: number) => new Date(value * 1000).toLocaleString();
  return (
    <section
      className="settings-card api-token-settings"
      aria-label={t("apiTokens")}
    >
      <h2>{t("apiTokens")}</h2>
      <p className="muted">{t("apiTokensHint")}</p>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {created && (
        <div className="notice" role="status">
          <p>{t("apiTokenShownOnce")}</p>
          <label className="field">
            <span>{t("apiTokenSecret")}</span>
            <input
              ref={secretField}
              readOnly
              value={created.token}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <div className="row gap">
            <button
              className="button secondary"
              onClick={() =>
                void action.run(async () => {
                  secretField.current?.select();
                  if (!navigator.clipboard) return;
                  await navigator.clipboard.writeText(created.token);
                  setCopied(true);
                })
              }
            >
              {t(copied ? "apiTokenCopied" : "copyApiToken")}
            </button>
            <button className="text-button" onClick={() => setCreated(null)}>
              {t("close")}
            </button>
          </div>
        </div>
      )}
      {canCreate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const data = new FormData(form);
            void action.run(async () => {
              const expires = data.get("expires") as string;
              const token = await api<APIToken & { token: string }>(
                path,
                send({
                  name: data.get("name"),
                  expires: expires
                    ? new Date(`${expires}T23:59:59`).toISOString()
                    : null,
                }),
              );
              setCreated(token);
              setCopied(false);
              form.reset();
              resource.reload();
            });
          }}
        >
          <label className="field">
            <span>{t("apiTokenName")}</span>
            <input name="name" required maxLength={128} autoComplete="off" />
          </label>
          <label className="field">
            <span>{t("apiTokenExpires")}</span>
            <input
              name="expires"
              aria-label={t("apiTokenExpires")}
              type="date"
              defaultValue={suggestedExpiry}
            />
            <small>{t("apiTokenExpiryHint")}</small>
          </label>
          <button
            className="button primary"
            disabled={action.pending || resource.pending || !!created}
          >
            {t("createApiToken")}
          </button>
        </form>
      )}
      {resource.pending ? (
        <p>{t("loading")}</p>
      ) : (
        <div className="administration-table">
          <table>
            <thead>
              <tr>
                <th>{t("apiTokenName")}</th>
                <th>{t("apiTokenCreated")}</th>
                <th>{t("apiTokenExpires")}</th>
                <th>{t("apiTokenLastUsed")}</th>
                <th>{t("actions")}</th>
              </tr>
            </thead>
            <tbody>
              {resource.data?.map((token) => (
                <tr key={token.id}>
                  <td>{token.name}</td>
                  <td>{date(token.created)}</td>
                  <td>
                    {token.expires === null
                      ? t("apiTokenNoExpiry")
                      : date(token.expires)}
                  </td>
                  <td>
                    {token.last_used === null
                      ? t("apiTokenUnused")
                      : date(token.last_used)}
                  </td>
                  <td>
                    {revoke === token.id ? (
                      <>
                        <p>{t("revokeApiTokenHint")}</p>
                        <button
                          className="text-button danger"
                          disabled={action.pending}
                          onClick={() =>
                            void action.run(async () => {
                              await api(`${path}/${token.id}`, {
                                method: "DELETE",
                              });
                              if (created?.id === token.id) setCreated(null);
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
                        onClick={() => setRevoke(token.id)}
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
            <p className="muted">{t("noApiTokens")}</p>
          )}
        </div>
      )}
    </section>
  );
}
