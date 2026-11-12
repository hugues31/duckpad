import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "./api";
import { useT } from "./i18n";
import { ConfirmModal } from "./modals";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";

type SSHKey = { public_key: string; fingerprint: string; created: string };

/** The account's Duckpad-generated SSH key; only its public half ever reaches the browser. */
export default function SSHKeySettings() {
  const t = useT();
  const resource = useApiResource<SSHKey | null>("/ssh-key");
  const { data: key, setData: setKey } = resource;
  const [confirm, setConfirm] = useState<"regenerate" | "delete" | null>(null);
  const [copied, setCopied] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const { pending, run, ...action } = useAsyncAction();
  const error = action.error || resource.error;
  const generate = async () => {
    setKey(await api<SSHKey>("/ssh-key", { method: "POST" }));
    setCopied(false);
  };
  const copy = async () => {
    field.current?.select();
    // The clipboard API is unavailable on plain HTTP origins; the key stays selected for copying.
    if (!navigator.clipboard || !key) return;
    await navigator.clipboard.writeText(key.public_key).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };
  return (
    <section className="settings-card" aria-labelledby="ssh-key-heading">
      <h2 id="ssh-key-heading">{t("sshKey")}</h2>
      <p className="muted">{t("sshKeyDescription")}</p>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {resource.pending ? (
        <p>{t("loading")}</p>
      ) : resource.error && !key ? null : key ? (
        <>
          <label className="field">
            <span>{t("sshPublicKey")}</span>
            <textarea
              ref={field}
              className="ssh-public-key"
              readOnly
              rows={3}
              aria-label={t("sshPublicKey")}
              aria-describedby="ssh-public-key-hint"
              value={key.public_key}
              onFocus={(e) => e.target.select()}
            />
            <small className="muted" id="ssh-public-key-hint">
              {t("sshPublicKeyHint")}
            </small>
          </label>
          <dl className="ssh-key-details">
            <dt>{t("sshFingerprint")}</dt>
            <dd>
              <code>{key.fingerprint}</code>
            </dd>
            <dt>{t("sshKeyCreated")}</dt>
            <dd>{new Date(key.created).toLocaleString()}</dd>
          </dl>
          <div className="settings-actions">
            <button
              className="button secondary"
              disabled={pending}
              onClick={() => void copy()}
            >
              {t(copied ? "sshKeyCopied" : "copySshPublicKey")}
            </button>
            <button
              className="button secondary"
              disabled={pending}
              onClick={() => setConfirm("regenerate")}
            >
              {t("regenerateSshKey")}
            </button>
            <button
              className="button secondary danger"
              disabled={pending}
              onClick={() => setConfirm("delete")}
            >
              {t("deleteSshKey")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>{t("noSshKey")}</p>
          <button
            className="button primary"
            disabled={pending}
            onClick={() => void run(generate)}
          >
            {t(pending ? "loading" : "generateSshKey")}
          </button>
        </>
      )}
      {confirm &&
        createPortal(
          <ConfirmModal
            title={t(
              confirm === "delete" ? "deleteSshKey" : "regenerateSshKey",
            )}
            confirmLabel={t(
              confirm === "delete" ? "deleteSshKey" : "regenerateSshKey",
            )}
            onConfirm={async () => {
              if (confirm === "delete") {
                await api("/ssh-key", { method: "DELETE" });
                setKey(null);
              } else await generate();
            }}
            onClose={() => setConfirm(null)}
          >
            <p>
              {t(
                confirm === "delete"
                  ? "deleteSshKeyWarning"
                  : "regenerateSshKeyWarning",
              )}
            </p>
          </ConfirmModal>,
          document.body,
        )}
    </section>
  );
}
