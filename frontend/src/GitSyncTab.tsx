import { useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { ApiError, api, send, withQuery } from "./api";
import ComparisonView from "./ComparisonView";
import { TabStatus, useTabAction, type Repository } from "./gitTabs";
import { useT, useTranslateValue } from "./i18n";
import { ConfirmModal } from "./modals";
import type { Json } from "./types";

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
  onChanged: (remote: Json) => Promise<void>;
  onReview: (review: Json) => void;
  onClose: () => void;
}) {
  const t = useT();
  const translateValue = useTranslateValue();
  const { pending, error, run, retry } = useTabAction();
  const { remote } = repository;
  const canEdit = role !== "reader";
  const admin = role === "admin";
  const [url, setUrl] = useState(remote?.url || "");
  const [mapping, setMapping] = useState(
    remote?.remote_branch || remote?.local_branch || "",
  );
  const [publication, setPublication] = useState<{
    remote: Json;
    diff: Json;
  } | null>(null);
  // A new origin state resets the form and invalidates the reviewed publication.
  const [formRemote, setFormRemote] = useState(remote);
  if (remote !== formRemote) {
    setFormRemote(remote);
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
        const detail = e instanceof ApiError ? (e.detail as Json) : null;
        if (detail?.consent_required) {
          setConsent({ url: detail.consent_required.url, retry: action });
          return;
        }
        if (detail?.ssh_key_required) setKeyRequired(true);
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

  const heads = {
    config_revision: remote.config_revision,
    local_head: remote.local_head,
    remote_head: remote.remote_head,
  };
  const syncReason = !canEdit
    ? t("gitReaderHint")
    : remote.pending ||
      (!remote.url
        ? t("configureOriginHint")
        : !remote.remote_branch
          ? t("mappingRequired")
          : !remote.checked
            ? t("fetchFirst")
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
      <div className="git-sync-summary">
        <strong>
          {remote.local_branch} → origin/{remote.remote_branch || "—"}
        </strong>
        <span className="badge">{translateValue("sync_" + remote.state)}</span>
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
        <p>
          {t("localHead")}: <code>{remote.local_head}</code>
          <br />
          {t("remoteHead")}: <code>{remote.remote_head || "—"}</code>
        </p>
      </div>
      <details open={!remote.url}>
        <summary>{t("remoteConfiguration")}</summary>
        <p>{t("gitAuthenticationHint")}</p>
        <form
          className="git-controls"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () =>
              onChanged(
                await api<Json>(
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
          <button
            type="button"
            className="button secondary"
            disabled={pending || !admin || !remote.url}
            onClick={() =>
              act(async () =>
                onChanged(
                  await api<Json>(
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
        </form>
        {!admin && <p className="notice">{t("remoteAdminHint")}</p>}
      </details>
      {syncReason && <p className="notice">{syncReason}</p>}
      <div className="git-controls">
        <button
          className="button secondary"
          disabled={pending || repository.loading}
          onClick={() => void repository.reload()}
        >
          {t("reloadState")}
        </button>
        <button
          className="button primary"
          disabled={pending || !canEdit || !remote.url}
          onClick={() =>
            network(async () =>
              onChanged(
                await api<Json>(
                  `${base}/fetch`,
                  send({ config_revision: remote.config_revision }),
                ),
              ),
            )
          }
        >
          {t("fetchRemote")}
        </button>
        <button
          className="button secondary"
          disabled={
            actionDisabled ||
            !remote.remote_head ||
            remote.state === "unrelated"
          }
          onClick={() =>
            act(async () =>
              onReview(await api<Json>(`${base}/pull`, send(heads))),
            )
          }
        >
          {t("reviewPull")}
        </button>
        <button
          className="button secondary"
          disabled={
            actionDisabled ||
            ["behind", "diverged", "unrelated", "unverified"].includes(
              remote.state,
            )
          }
          onClick={() =>
            act(async () => {
              const diff = await api<Json>(
                withQuery(`${base}/compare`, {
                  a: remote.remote_head || "empty",
                  b: remote.local_head,
                }),
              );
              setPublication({ remote, diff });
              setRecreate(false);
            })
          }
        >
          {t("reviewPush")}
        </button>
      </div>
      <p className="muted">{t("fetchPullHint")}</p>
      {[
        "behind",
        "diverged",
        "unrelated",
        "unverified",
        "remote_deleted",
      ].includes(remote.state) && (
        <p className="notice">{translateValue("recovery_" + remote.state)}</p>
      )}
      {publication && (
        <section className="publication-review">
          <h3>
            {t("publishReviewedHead")}:{" "}
            {publication.remote.local_head.slice(0, 12)} → origin/
            {publication.remote.remote_branch}
          </h3>
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
                  await api<Json>(
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
