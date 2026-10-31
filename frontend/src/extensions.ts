export type ExtensionSource = "core" | "community" | "unsigned";
export interface ProjectExtension {
  source: ExtensionSource;
  enabled: boolean;
}

export function extensionDownload(
  runtime: { version: string; platform: string },
  name: string,
  source: ExtensionSource,
) {
  if (source === "unsigned" || !/^[a-z][a-z0-9_]{0,63}$/.test(name))
    return null;
  const host =
    source === "community"
      ? "community-extensions.duckdb.org"
      : "extensions.duckdb.org";
  return `https://${host}/${runtime.version}/${runtime.platform}/${name}.duckdb_extension.gz`;
}

export const extensionSourceKey = (source: ExtensionSource) =>
  source === "core"
    ? "extensionCore"
    : source === "community"
      ? "extensionCommunity"
      : "extensionUnsigned";
