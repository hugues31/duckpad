import { useState } from "react";
import { importExtension } from "./api";
import { useT } from "./i18n";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import Select from "./Select";

type Source = "core" | "community" | "unsigned";
type Runtime = {
  version: string;
  platform: string;
  imports: { name: string; source: Source }[];
};

export default function ExtensionImport() {
  const t = useT();
  const {
    data: runtime,
    error: loadError,
    setData: setRuntime,
  } = useApiResource<Runtime>("/extensions/runtime");
  const [source, setSource] = useState<Source>("core");
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saved, setSaved] = useState(false);
  const { pending, run, ...save } = useAsyncAction();
  const error = save.error || loadError;
  const validName = /^[a-z][a-z0-9_]{0,63}$/.test(name);
  const host =
    source === "community"
      ? "community-extensions.duckdb.org"
      : "extensions.duckdb.org";
  const download =
    runtime && validName && source !== "unsigned"
      ? `https://${host}/${runtime.version}/${runtime.platform}/${name}.duckdb_extension.gz`
      : null;
  const sourceLabel = (value: Source) =>
    t(
      value === "core"
        ? "extensionCore"
        : value === "community"
          ? "extensionCommunity"
          : "extensionUnsigned",
    );
  return (
    <div>
      <h3>{t("extensionDownloadStep")}</h3>
      <p className="muted">{t("extensionDownloadHint")}</p>
      {runtime && (
        <p>
          {t("extensionServerRuntime")}:{" "}
          <code>
            {runtime.version} / {runtime.platform}
          </code>
        </p>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <label className="field">
        <span>{t("extensionSource")}</span>
        <Select
          aria-label={t("extensionSource")}
          value={source}
          disabled={pending}
          onChange={(event) => {
            setSource(event.target.value as Source);
            setSaved(false);
          }}
        >
          {(["core", "community", "unsigned"] as const).map((value) => (
            <option key={value} value={value}>
              {sourceLabel(value)}
            </option>
          ))}
        </Select>
      </label>
      <label className="field">
        <span>{t("extensionName")}</span>
        <input
          value={name}
          maxLength={64}
          placeholder="httpfs"
          disabled={pending}
          onChange={(event) => setName(event.target.value.trim().toLowerCase())}
        />
      </label>
      {download && (
        <p>
          <a
            className="button"
            href={download}
            target="_blank"
            rel="noreferrer"
          >
            {t("extensionDownload")}
          </a>
        </p>
      )}
      {source === "unsigned" && (
        <p className="muted">{t("extensionCustomHint")}</p>
      )}
      <h3>{t("extensionImportStep")}</h3>
      <p className="muted">{t("extensionImportHint")}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!file) return;
          setSaved(false);
          void run(async () => {
            setRuntime(await importExtension(file, source));
            setSaved(true);
          });
        }}
      >
        <label className="field">
          <span>{t("extensionFile")}</span>
          <input
            type="file"
            accept=".duckdb_extension,.gz"
            disabled={pending}
            onChange={(event) => {
              setFile(event.target.files?.[0] || null);
              setSaved(false);
            }}
          />
        </label>
        <button
          className="button primary"
          disabled={pending || !runtime || !file}
        >
          {t("extensionImport")}
        </button>
        {saved && <p role="status">{t("extensionImported")}</p>}
      </form>
      {!!runtime?.imports.length && (
        <div>
          <h3>{t("extensionImportedList")}</h3>
          <ul>
            {runtime.imports.map((item) => (
              <li key={item.name}>
                <code>{item.name}</code> · {sourceLabel(item.source)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
