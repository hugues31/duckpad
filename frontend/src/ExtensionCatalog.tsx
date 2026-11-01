import { ExternalLink } from "lucide-react";
import { useId, useMemo } from "react";
import {
  communityExtensions,
  extensionDownload,
  extensionLists,
  extensionSourceKey,
  publishedDownload,
  searchCatalog,
  type CatalogEntry,
  type CoreExtension,
  type ExtensionSource,
} from "./extensions";
import { useT } from "./i18n";
import { useResource } from "./useApiResource";

interface Runtime {
  version: string;
  platform: string;
  core_extensions: CoreExtension[];
}

/**
 * Extensions to pick instead of typing an exact name: core ones from the
 * server, community ones when this browser can reach DuckDB's website.
 */
export default function ExtensionCatalog({
  runtime,
  name,
  source,
  disabled,
  onPick,
}: {
  runtime: Runtime;
  name: string;
  source: ExtensionSource;
  disabled?: boolean;
  onPick: (entry: CatalogEntry) => void;
}) {
  const t = useT();
  const id = useId();
  const community = useResource("community", communityExtensions);
  const entries = useMemo(
    () =>
      searchCatalog(
        [
          ...runtime.core_extensions.map((entry) => ({
            ...entry,
            source: "core" as const,
          })),
          ...(community.data || []),
        ],
        name,
      ),
    [runtime.core_extensions, community.data, name],
  );
  return (
    <div className="extension-catalog">
      <div className="extension-catalog-header">
        <strong id={id}>{t("extensionCatalog")}</strong>
        {(["core", "community"] as const).map((list) => (
          <a
            key={list}
            href={extensionLists[list]}
            target="_blank"
            rel="noreferrer"
          >
            {t(
              list === "core" ? "extensionCoreList" : "extensionCommunityList",
            )}
            <ExternalLink size={12} aria-hidden />
          </a>
        ))}
      </div>
      <p className="muted">
        {community.pending
          ? t("extensionCatalogLoading")
          : community.error
            ? t("extensionCatalogOffline")
            : t("extensionCatalogHint")}
      </p>
      {entries.length ? (
        <ul className="extension-catalog-list" aria-labelledby={id}>
          {entries.map((entry) => {
            const selected = entry.name === name && entry.source === source;
            return (
              <li key={`${entry.source}:${entry.name}`}>
                <button
                  type="button"
                  aria-current={selected || undefined}
                  disabled={disabled}
                  onClick={() => onPick(entry)}
                >
                  {/* Spaces separate the parts of the button's accessible name. */}
                  <code>{entry.name}</code>{" "}
                  <span className="extension-catalog-source">
                    {t(extensionSourceKey(entry.source))}
                    {entry.built_in && ` · ${t("extensionBuiltIn")}`}
                  </span>{" "}
                  <span
                    className="extension-catalog-description"
                    title={entry.description}
                  >
                    {entry.description}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">{t("extensionCatalogNoMatch")}</p>
      )}
    </div>
  );
}

/** Whether the selected name has a download for the server's runtime. */
export function ExtensionAvailability({
  runtime,
  name,
  source,
}: {
  runtime: Runtime;
  name: string;
  source: ExtensionSource;
}) {
  const t = useT();
  const builtIn =
    source === "core" &&
    runtime.core_extensions.some(
      (entry) => entry.name === name && entry.built_in,
    );
  const url = builtIn ? null : extensionDownload(runtime, name, source);
  // Wait for typing to pause before asking DuckDB's repository.
  const { data: published } = useResource(
    url,
    (signal) => publishedDownload(url!, signal),
    { delay: 400 },
  );
  return (
    <p
      className={
        published === false
          ? "extension-availability missing"
          : "extension-availability"
      }
      aria-live="polite"
    >
      {builtIn
        ? t("extensionBuiltInHint")
        : published !== null && (
            <>
              {t(published ? "extensionPublished" : "extensionNotPublished")}:{" "}
              <code>
                {runtime.version} / {runtime.platform}
              </code>
              {!published && <> {t("extensionNotPublishedHint")}</>}
            </>
          )}
    </p>
  );
}
