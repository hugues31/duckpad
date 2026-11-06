import { useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { api, errorDetail, send, withQuery } from "./api";
import ComparisonView from "./ComparisonView";
import { TabStatus, useTabAction, type Repository } from "./gitTabs";
import type { Comparison, MergeReview, RemoteStatus } from "./gitTypes";
import { useT, useTranslateValue } from "./i18n";
import { ConfirmModal } from "./modals";

/** The origin state that the form and a reviewed publication belong to. */
const remoteRevision = (remote: RemoteStatus | null) =>
  JSON.stringify(
    remote && [
      remote.config_revision,
      remote.local_head,
      remote.remote_head,
      remote.checked,
    ],
  );

export default function GitSyncTab({
  base,
  role,
  storageKey,
  repository,
  onChanged,
  onReview,
  onClose,
}: {
  base: string;
  role: string;
  storageKey: string;
  repository: Repository;
  /** Refresh the workspace after a change, showing the returned origin state first. */
  onChanged: (remote: RemoteStatus) => Promise<void>;
  onReview: (review: MergeReview) => void;
  onClose: () => void;
}) {
  const t = useT();
  const translateValue = useTranslateValue();
  const { pending, error, run, retry } = useTabAction();
  const { remote } = repository;
  const canEdit = role === "admin" || role === "editor";
  const admin = role === "admin";
  const [url, setUrl] = useState(remote?.url || "");
  const [mapping, setMapping] = useState(
    remote?.remote_branch || remote?.local_branch || "",
  );
  const [publication, setPublication] = useState<{
    remote: RemoteStatus;
    diff: Comparison;
  } | null>(null);
  // A new origin state resets the form and invalidates the reviewed publication.
  const revision = remoteRevision(remote);
  const [formRemote, setFormRemote] = useState(revision);
  if (revision !== formRemote) {
    setFormRemote(revision);
    setUrl(remote?.url || "");
    setMapping(remote?.remote_branch || remote?.local_branch || "");
    setPublication(null);
  }
  const [recreate, setRecreate] = useState(false);
  const [keyRequired, setKeyRequired] = useState(false);
  const [consent, setConsent] = useState<{
    url: string;
    retry: () => Promise<void>;
  } | null>(null);

  const act = (action: () => Promise<unknown>) => {
    setKeyRequired(false);
    return run(action);
  };
  /** Fetch and push use the account's SSH key, which needs consent for the displayed origin. */
  const network = (action: () => Promise<void>) =>
    act(async () => {
      try {
        await action();
      } catch (e) {
        const detail = errorDetail(e);
        const consentRequired = detail.consent_required as
          { url: string } | undefined;
        if (consentRequired) {
          setConsent({ url: consentRequired.url, retry: action });
          return;
        }
        if (detail.ssh_key_required) setKeyRequired(true);
        throw e;
      }
    });

  if (!remote)
    return (
      <div className="git-sync-panel">
        <TabStatus
          error={repository.failure?.message}
          onRetry={repository.failure?.retry}
        />
        {!repository.failure && <p role="status">{t("loading")}</p>}
      </div>
    );

  const syncReason = !canEdit
    ? t("gitReaderHint")
    : remote.pending ||
      (!remote.url
        ? t("configureOriginHint")
        : !remote.remote_branch
          ? t("mappingRequired")
          : "");
  const actionDisabled = pending || !!syncReason;

  return (
    <div className="git-sync-panel">
      <TabStatus
        error={repository.failure?.message}
        onRetry={repository.failure?.retry}
      />
      <TabStatus
        error={error}
        pending={pending}
        onRetry={retry}
        action={
          keyRequired ? (
            <Link
              className="button secondary small"
              to="/user-settings"
              onClick={onClose}
            >
              {t("openUserSettings")}
            </Link>
          ) : undefined
        }
      />
      {remote.url && (
        <div className="git-sync-summary">
          <strong>
            {remote.local_branch} → origin/{remote.remote_branch || "—"}
          </strong>
          <span className="badge">{t(`sync_${remote.state}`)}</span>
          <p>
            {remote.ahead ?? "—"} {t("toPush")} / {remote.behind ?? "—"}{" "}
            {t("toIntegrate")}
          </p>
          <small>
            {t("lastCheck")}:{" "}
            {remote.checked
              ? new Date(remote.checked).toLocaleString()
              : t("neverChecked")}
          </small>
        </div>
      )}
      <details open={!remote.url}>
        <summary>{t("remoteConfiguration")}</summary>
        <p>{t("gitAuthenticationHint")}</p>
        <form
          className="git-controls"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () =>
              onChanged(
                await api<RemoteStatus>(
                  `${base}/remote`,
                  send(
                    {
                      url,
                      remote_branch: mapping,
                      config_revision: remote.config_revision,
                    },
                    "PUT",
                  ),
                ),
              ),
            );
          }}
        >
          <label>
            {t("repositoryUrl")}{" "}
            <input
              required
              placeholder="git@git.example.com:team/project.git"
              disabled={!admin}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label>
            {t("remoteBranch")}{" "}
            <input
              required
              disabled={!admin}
              value={mapping}
              onChange={(e) => setMapping(e.target.value)}
            />
          </label>
          <button className="button primary" disabled={pending || !admin}>
            {t("saveConfiguration")}
          </button>
          {remote.url && (
            <button
              type="button"
              className="button secondary"
              disabled={pending || !admin || !remote.url}
              onClick={() =>
                act(async () =>
                  onChanged(
                    await api<RemoteStatus>(
                      `${base}/remote`,
                      send(
                        { url: null, config_revision: remote.config_revision },
                        "PUT",
                      ),
                    ),
                  ),
                )
              }
            >
              {t("disconnectRemote")}
            </button>
          )}
        </form>
        {!admin && <p className="notice">{t("remoteAdminHint")}</p>}
      </details>
      {remote.url && (
        <>
          {syncReason && <p className="notice">{syncReason}</p>}
          <div className="git-controls">
            <button
              className="button primary"
              disabled={actionDisabled}
              onClick={() =>
                network(async () => {
                  const fresh = await api<RemoteStatus>(
                    `${base}/fetch`,
                    send({ config_revision: remote.config_revision }),
                  );
                  await onChanged(fresh);
                  onReview(
                    await api<MergeReview>(
                      `${base}/pull`,
                      send({
                        config_revision: fresh.config_revision,
                        local_head: fresh.local_head,
                        remote_head: fresh.remote_head,
                      }),
                    ),
                  );
                })
              }
            >
              {t("gitPull")}
            </button>
            <button
              className="button secondary"
              disabled={actionDisabled}
              onClick={() =>
                network(async () => {
                  const fresh = await api<RemoteStatus>(
                    `${base}/fetch`,
                    send({ config_revision: remote.config_revision }),
                  );
                  await onChanged(fresh);
                  if (
                    ["behind", "diverged", "unrelated", "unverified"].includes(
                      fresh.state,
                    )
                  )
                    throw new Error(translateValue("recovery_" + fresh.state));
                  const diff = await api<Comparison>(
                    withQuery(`${base}/compare`, {
                      a: fresh.remote_head || "empty",
                      b: fresh.local_head,
                    }),
                  );
                  setFormRemote(remoteRevision(fresh));
                  setPublication({ remote: fresh, diff });
                  setRecreate(false);
                })
              }
            >
              {t("gitPush")}
            </button>
          </div>
          <details className="git-sync-details">
            <summary>{t("gitDetails")}</summary>
            <p>
              {t("localHead")}: <code>{remote.local_head}</code>
              <br />
              {t("remoteHead")}: <code>{remote.remote_head || "—"}</code>
            </p>
            <p className="muted">{t("fetchPullHint")}</p>
            <div className="git-controls">
              <button
                className="button secondary"
                disabled={pending || repository.loading}
                onClick={() => void repository.reload()}
              >
                {t("reloadState")}
              </button>
              <button
                className="button secondary"
                disabled={pending || !canEdit}
                onClick={() =>
                  network(async () =>
                    onChanged(
                      await api<RemoteStatus>(
                        `${base}/fetch`,
                        send({ config_revision: remote.config_revision }),
                      ),
                    ),
                  )
                }
              >
                {t("fetchRemote")}
              </button>
            </div>
          </details>
        </>
      )}
      {publication && (
        <section className="publication-review">
          <h3>
            {t("publishReviewedHead")}: {publication.remote.local_branch} →
            origin/
            {publication.remote.remote_branch}
          </h3>
          <details>
            <summary>{t("gitDetails")}</summary>
            <code>{publication.remote.local_head}</code>
          </details>
          <ComparisonView
            report={publication.diff}
            storageKey={storageKey + ".publishFilters"}
          />
          {publication.remote.state === "remote_deleted" && (
            <label>
              <input
                type="checkbox"
                checked={recreate}
                onChange={(e) => setRecreate(e.target.checked)}
              />{" "}
              {t("recreateRemoteBranch")}
            </label>
          )}
          <button
            className="button primary"
            disabled={
              pending ||
              (publication.remote.state === "remote_deleted" && !recreate)
            }
            onClick={() =>
              network(async () =>
                onChanged(
                  await api<RemoteStatus>(
                    `${base}/push`,
                    send({
                      config_revision: publication.remote.config_revision,
                      local_head: publication.remote.local_head,
                      remote_head: publication.remote.remote_head,
                      recreate,
                    }),
                  ),
                ),
              )
            }
          >
            {t("publishReviewedHead")}
          </button>
        </section>
      )}
      {consent &&
        createPortal(
          <ConfirmModal
            title={t("confirmGitOrigin")}
            confirmLabel={t("useSshKeyForOrigin")}
            onConfirm={async () => {
              await api(`${base}/consent`, send({ url: consent.url }));
              void network(consent.retry);
            }}
            onClose={() => setConsent(null)}
          >
            <p>{t("gitConsentDescription")}</p>
            <code className="git-consent-url">{consent.url}</code>
            <p className="muted">{t("gitConsentRenewal")}</p>
          </ConfirmModal>,
          document.body,
        )}
    </div>
  );
}
