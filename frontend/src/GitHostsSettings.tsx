import { useEffect, useState } from "react";
import { api, send } from "./api";
import { useT } from "./i18n";
import { useAsyncAction } from "./useAsyncAction";

type GitHosts = {
  known_hosts: string;
  host_keys: { hosts: string[]; type: string; fingerprint: string }[];
  prefixes: string[];
};

/** Trusted SSH host keys and allowed origin prefixes for every project's network Git. */
export default function GitHostsSettings() {
  const t = useT();
  const [settings, setSettings] = useState<GitHosts | null>(null);
  const [knownHosts, setKnownHosts] = useState("");
  const [prefixes, setPrefixes] = useState("");
  const [saved, setSaved] = useState(false);
  const { pending, error, setError, run } = useAsyncAction();
  const show = (value: GitHosts) => {
    setSettings(value);
    setKnownHosts(value.known_hosts);
    setPrefixes(value.prefixes.join("\n"));
  };
  useEffect(() => {
    let live = true;
    api<GitHosts>("/git-hosts")
      .then((value) => {
        if (live) show(value);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [setError]);
  return (
    <section className="settings-card" aria-labelledby="git-hosts-heading">
      <h2 id="git-hosts-heading">{t("gitHosts")}</h2>
      <p className="muted">{t("gitHostsDescription")}</p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {!settings ? (
        <p>{t("loading")}</p>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSaved(false);
            void run(async () => {
              show(
                await api<GitHosts>(
                  "/git-hosts",
                  send(
                    {
                      known_hosts: knownHosts,
                      prefixes: prefixes
                        .split("\n")
                        .map((value) => value.trim())
                        .filter(Boolean),
                    },
                    "PUT",
                  ),
                ),
              );
              setSaved(true);
            });
          }}
        >
          <fieldset disabled={pending} className="git-hosts-fields">
            <label className="field">
              <span>{t("trustedHostKeys")}</span>
              <textarea
                className="code-input"
                rows={6}
                spellCheck={false}
                aria-label={t("trustedHostKeys")}
                aria-describedby="trusted-host-keys-hint"
                placeholder="git.example.com ssh-ed25519 AAAAC3Nz…"
                value={knownHosts}
                onChange={(e) => {
                  setKnownHosts(e.target.value);
                  setSaved(false);
                }}
              />
              <small className="muted" id="trusted-host-keys-hint">
                {t("trustedHostKeysHint")}
              </small>
            </label>
            <label className="field">
              <span>{t("allowedOriginPrefixes")}</span>
              <textarea
                className="code-input"
                rows={3}
                spellCheck={false}
                aria-label={t("allowedOriginPrefixes")}
                aria-describedby="allowed-origin-prefixes-hint"
                placeholder="git@git.example.com:team/"
                value={prefixes}
                onChange={(e) => {
                  setPrefixes(e.target.value);
                  setSaved(false);
                }}
              />
              <small className="muted" id="allowed-origin-prefixes-hint">
                {t("allowedOriginPrefixesHint")}
              </small>
            </label>
            <button className="button primary">
              {t(pending ? "saving" : "saveGitHosts")}
            </button>
          </fieldset>
          {saved && <p role="status">{t("gitHostsSaved")}</p>}
        </form>
      )}
      {settings && (
        <>
          <h3>{t("trustedHostKeys")}</h3>
          {settings.host_keys.length ? (
            <div className="administration-table">
              <table className="git-host-keys">
                <thead>
                  <tr>
                    <th>{t("gitHost")}</th>
                    <th>{t("hostKeyType")}</th>
                    <th>{t("sshFingerprint")}</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.host_keys.map((entry, index) => (
                    <tr key={index}>
                      <td>{entry.hosts.join(", ")}</td>
                      <td>{entry.type}</td>
                      <td>
                        <code>{entry.fingerprint}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">{t("noTrustedHosts")}</p>
          )}
        </>
      )}
    </section>
  );
}
