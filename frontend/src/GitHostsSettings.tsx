import { api, send } from "./api";
import { useT } from "./i18n";
import SettingsCard from "./SettingsCard";
import { useApiResource } from "./useApiResource";
import { useSettingsForm } from "./useSettingsForm";

type GitHosts = {
  known_hosts: string;
  host_keys: { hosts: string[]; type: string; fingerprint: string }[];
  prefixes: string[];
};

/** Trusted SSH host keys and allowed origin prefixes for every project's network Git. */
export default function GitHostsSettings() {
  const t = useT();
  const resource = useApiResource<GitHosts>("/git-hosts");
  const settings = resource.data;
  const {
    config,
    change,
    pending,
    saved,
    submit,
    error: saveError,
  } = useSettingsForm(
    settings && {
      knownHosts: settings.known_hosts,
      prefixes: settings.prefixes.join("\n"),
    },
    async (config) => {
      resource.setData(
        await api<GitHosts>(
          "/git-hosts",
          send(
            {
              known_hosts: config.knownHosts,
              prefixes: config.prefixes
                .split("\n")
                .map((value) => value.trim())
                .filter(Boolean),
            },
            "PUT",
          ),
        ),
      );
    },
  );
  const knownHosts = config?.knownHosts || "";
  const prefixes = config?.prefixes || "";
  const error = saveError || resource.error;
  return (
    <SettingsCard
      title={t("gitHosts")}
      description={t("gitHostsDescription")}
      error={error}
      loading={!settings}
    >
      {settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={pending} className="git-hosts-fields">
            <div className="settings-fields">
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
                    change({ knownHosts: e.target.value });
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
                    change({ prefixes: e.target.value });
                  }}
                />
                <small className="muted" id="allowed-origin-prefixes-hint">
                  {t("allowedOriginPrefixesHint")}
                </small>
              </label>
            </div>
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
    </SettingsCard>
  );
}
