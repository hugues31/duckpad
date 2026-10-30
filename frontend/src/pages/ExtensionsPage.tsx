import { useState } from "react";
import { Link } from "react-router";
import { api, send } from "../api";
import {
  extensionDownload,
  extensionSourceKey,
  type ExtensionSource,
  type ProjectExtension,
} from "../extensions";
import { useT } from "../i18n";
import Select from "../Select";
import { useWorkspace } from "../shell";
import { useApiResource } from "../useApiResource";
import { useAsyncAction } from "../useAsyncAction";
import { useLoadedWorktree } from "../worktree";
import { InvalidProject } from "./PageStates";

interface ExtensionState extends ProjectExtension {
  name: string;
  status: "ready" | "missing" | "incompatible" | "policy";
  message?: string;
}
interface Extensions {
  version: string;
  platform: string;
  requirements: ExtensionState[];
}

export default function ExtensionsPage() {
  const t = useT();
  const { user } = useWorkspace();
  const { id, snapshot, canEdit, save, statuses } = useLoadedWorktree();
  const {
    data,
    error: loadError,
    reload,
  } = useApiResource<Extensions>(`/worktrees/${id}/extensions`, {
    refresh: snapshot.revision,
  });
  const [name, setName] = useState("");
  const [source, setSource] = useState<ExtensionSource>("core");
  const { pending, error, run } = useAsyncAction();
  const [failed, setFailed] = useState<string | null>(null);
  if (!snapshot.bundle) return <InvalidProject />;
  const busy = pending || !!statuses.active;
  const valid = /^[a-z][a-z0-9_]{0,63}$/.test(name);

  async function change(
    update: (items: Record<string, ProjectExtension>) => void,
  ) {
    await save(snapshot, (bundle) => {
      const entries = bundle.extensions || {};
      if (typeof entries !== "object" || Array.isArray(entries))
        throw new Error(t("projectExtensionsInvalid"));
      update(entries);
      bundle.extensions = entries;
    });
  }

  async function check(item: ExtensionState) {
    setFailed(null);
    try {
      await api(
        `/worktrees/${id}/extensions/check`,
        send({ name: item.name, source: item.source }),
      );
    } catch (error) {
      setFailed(item.name);
      throw error;
    }
  }

  return (
    <section className="full-panel project-extensions-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("extensions")}</span>
          <h1>{t("projectExtensionsTitle")}</h1>
          <p>{t("projectExtensionsHint")}</p>
        </div>
        <button
          className="button secondary"
          onClick={reload}
          disabled={pending}
        >
          {t("projectExtensionsRefresh")}
        </button>
      </div>
      {(error || loadError) && (
        <div className="notice error" role="alert">
          {error || loadError}
        </div>
      )}
      {statuses.active && (
        <p className="notice">{t("projectExtensionsStop")}</p>
      )}
      {data && (
        <p className="muted">
          {t("extensionServerRuntime")}:{" "}
          <code>
            {data.version} / {data.platform}
          </code>
        </p>
      )}
      {canEdit && !loadError && data && (
        <form
          className="project-extension-add"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await change((items) => {
                if (items[name])
                  throw new Error(t("projectExtensionDuplicate"));
                items[name] = { source, enabled: false };
              });
              setName("");
            });
          }}
        >
          <label className="field">
            <span>{t("extensionName")}</span>
            <input
              value={name}
              maxLength={64}
              placeholder="duckfn_statrs"
              disabled={busy}
              onChange={(event) =>
                setName(event.target.value.trim().toLowerCase())
              }
            />
          </label>
          <label className="field">
            <span>{t("extensionSource")}</span>
            <Select
              aria-label={t("extensionSource")}
              value={source}
              disabled={busy}
              onChange={(event) =>
                setSource(event.target.value as ExtensionSource)
              }
            >
              {(["core", "community", "unsigned"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(extensionSourceKey(value))}
                </option>
              ))}
            </Select>
          </label>
          <button className="button primary" disabled={busy || !valid}>
            {t("projectExtensionAdd")}
          </button>
        </form>
      )}
      <div className="project-extension-list">
        {data?.requirements.map((item) => {
          const download = extensionDownload(data, item.name, item.source);
          const status =
            failed === item.name
              ? "projectExtensionLoadError"
              : item.status === "ready"
                ? item.enabled
                  ? "projectExtensionActive"
                  : "projectExtensionReady"
                : item.status === "policy"
                  ? "projectExtensionPolicy"
                  : item.status === "incompatible"
                    ? "projectExtensionIncompatible"
                    : "projectExtensionMissing";
          return (
            <article
              className="project-extension-card"
              key={item.name}
              aria-label={item.name}
            >
              <div>
                <h2>
                  <code>{item.name}</code>
                </h2>
                <p>{t(extensionSourceKey(item.source))}</p>
                <strong role="status">{t(status)}</strong>
                {item.enabled && item.status !== "ready" && (
                  <p>{t("projectExtensionRequired")}</p>
                )}
                {item.message && <p>{item.message}</p>}
              </div>
              <div className="project-extension-actions">
                {canEdit && (
                  <>
                    <button
                      className="button primary"
                      disabled={
                        busy || (!item.enabled && item.status !== "ready")
                      }
                      onClick={() =>
                        void run(async () => {
                          if (!item.enabled) {
                            await check(item);
                          }
                          await change((entries) => {
                            entries[item.name] = {
                              source: item.source,
                              enabled: !item.enabled,
                            };
                          });
                        })
                      }
                    >
                      {t(
                        item.enabled
                          ? "projectExtensionDeactivate"
                          : "projectExtensionActivate",
                      )}
                    </button>
                    {item.enabled && (
                      <button
                        className="button secondary"
                        disabled={busy || item.status !== "ready"}
                        onClick={() =>
                          void run(async () => {
                            await check(item);
                          })
                        }
                      >
                        {t("projectExtensionCheck")}
                      </button>
                    )}
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          change((entries) => {
                            delete entries[item.name];
                          }),
                        )
                      }
                    >
                      {t("remove")}
                    </button>
                  </>
                )}
                {download && (
                  <a
                    className="button secondary"
                    href={download}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {t("extensionDownload")}
                  </a>
                )}
                {user.role === "admin" ? (
                  <Link
                    className="button secondary"
                    to={`/instance-settings/extensions?${new URLSearchParams({ name: item.name, source: item.source })}`}
                  >
                    {t("projectExtensionImport")}
                  </Link>
                ) : (
                  item.status !== "ready" && (
                    <p className="muted">{t("projectExtensionAskAdmin")}</p>
                  )
                )}
              </div>
            </article>
          );
        })}
        {data && !data.requirements.length && (
          <p className="empty-state">{t("projectExtensionsEmpty")}</p>
        )}
      </div>
      <p className="muted">{t("projectExtensionsOffline")}</p>
    </section>
  );
}
