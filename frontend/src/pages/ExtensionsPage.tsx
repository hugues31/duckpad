import { Download, FlaskConical, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api, send } from "../api";
import {
  extensionDownload,
  extensionSourceKey,
  type ExtensionSource,
  type ProjectExtension,
} from "../extensions";
import { useT, type TranslationKey } from "../i18n";
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
    pending: refreshing,
    reload,
  } = useApiResource<Extensions>(`/worktrees/${id}/extensions`, {
    refresh: snapshot.revision,
  });
  const [name, setName] = useState("");
  const [source, setSource] = useState<ExtensionSource>("core");
  const { pending, error, run } = useAsyncAction();
  const [failed, setFailed] = useState<string | null>(null);
  const [toggling, setToggling] = useState<{
    name: string;
    data: Extensions | null;
  } | null>(null);
  if (!snapshot.bundle) return <InvalidProject />;
  const busy = pending || refreshing || !!statuses.active;
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
          const [status, tone]: [TranslationKey, string] =
            failed === item.name
              ? ["projectExtensionLoadError", "failed"]
              : item.status === "ready"
                ? item.enabled
                  ? ["projectExtensionActive", "success"]
                  : ["projectExtensionReady", "neutral"]
                : item.status === "policy"
                  ? ["projectExtensionPolicy", "blocked"]
                  : item.status === "incompatible"
                    ? ["projectExtensionIncompatible", "blocked"]
                    : ["projectExtensionMissing", "blocked"];
          // Tick the box at once; the saved state replaces it on the next load.
          const enabled =
            item.enabled !==
            (toggling?.name === item.name && toggling.data === data);
          const askAdmin = user.role !== "admin" && item.status !== "ready";
          return (
            <article
              className="project-extension-card"
              key={item.name}
              aria-label={item.name}
            >
              <div className="project-extension-row">
                {canEdit && (
                  <label
                    className="project-extension-toggle"
                    data-tooltip={t(
                      enabled
                        ? "projectExtensionDeactivate"
                        : "projectExtensionActivate",
                    )}
                  >
                    <input
                      type="checkbox"
                      aria-label={t("projectExtensionActivate")}
                      checked={enabled}
                      disabled={
                        busy || (!item.enabled && item.status !== "ready")
                      }
                      onChange={() =>
                        void run(async () => {
                          setToggling({ name: item.name, data });
                          try {
                            if (!item.enabled) await check(item);
                            await change((entries) => {
                              entries[item.name] = {
                                source: item.source,
                                enabled: !item.enabled,
                              };
                            });
                          } catch (error) {
                            setToggling(null);
                            throw error;
                          }
                        })
                      }
                    />
                  </label>
                )}
                <h2>
                  <code>{item.name}</code>
                </h2>
                <span className="project-extension-source">
                  {t(extensionSourceKey(item.source))}
                </span>
                <strong role="status" className={`badge ${tone}`}>
                  {t(status)}
                </strong>
                <div className="project-extension-actions">
                  {canEdit && item.enabled && (
                    <button
                      className="project-extension-action"
                      aria-label={t("projectExtensionCheck")}
                      data-tooltip={t("projectExtensionCheck")}
                      disabled={busy || item.status !== "ready"}
                      onClick={() =>
                        void run(async () => {
                          await check(item);
                        })
                      }
                    >
                      <FlaskConical size={16} />
                    </button>
                  )}
                  {download && (
                    <a
                      className="project-extension-action"
                      aria-label={t("extensionDownload")}
                      data-tooltip={t("extensionDownload")}
                      href={download}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download size={16} />
                    </a>
                  )}
                  {user.role === "admin" && (
                    <Link
                      className="project-extension-action"
                      aria-label={t("projectExtensionImport")}
                      data-tooltip={t("projectExtensionImport")}
                      to={`/instance-settings/extensions?${new URLSearchParams({ name: item.name, source: item.source })}`}
                    >
                      <Upload size={16} />
                    </Link>
                  )}
                  {canEdit && (
                    <button
                      className="project-extension-action remove"
                      aria-label={t("remove")}
                      data-tooltip={t("remove")}
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          change((entries) => {
                            delete entries[item.name];
                          }),
                        )
                      }
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </div>
              </div>
              {((item.enabled && item.status !== "ready") ||
                item.message ||
                askAdmin) && (
                <div className="project-extension-notes">
                  {item.enabled && item.status !== "ready" && (
                    <p>{t("projectExtensionRequired")}</p>
                  )}
                  {item.message && <p>{item.message}</p>}
                  {askAdmin && <p>{t("projectExtensionAskAdmin")}</p>}
                </div>
              )}
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
