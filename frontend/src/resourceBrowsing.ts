import { api, withQuery } from "./api";
import type { DatabaseObjects } from "./types";

/** What a connection holds: folders and files, or schemas and tables. */
export interface BrowserEntry {
  /** The containers of the entry, then its own name. */
  path: string[];
  kind: "folder" | "file" | "pattern" | "schema" | "table" | "view";
  /** Bytes of a file. */
  size?: number | null;
  /** When a file last changed, as an ISO date. */
  modified?: string | null;
  /** Tables of a schema, or files matched by a pattern. */
  count?: number;
}
export interface BrowserLevel {
  entries: BrowserEntry[];
  /** Only the first entries are listed; a filter narrows them on the server. */
  truncated: boolean;
}
/** Lists one container of a connection, keeping the names that match a filter. */
export type BrowserSource = (
  path: string[],
  filter: string,
  signal: AbortSignal,
) => Promise<BrowserLevel>;

export const isContainer = (entry: BrowserEntry) =>
  entry.kind === "folder" || entry.kind === "schema";

const contains = (name: string, filter: string) =>
  name.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase());

/** File formats whose readers accept a `*` pattern over several files. */
const PATTERN_FORMATS = ["csv", "tsv", "parquet", "json", "jsonl", "ndjson"];

/** A `*.csv` entry for each format that several files of a folder share. */
export function filePatterns(
  path: string[],
  entries: BrowserEntry[],
): BrowserEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const extension = entry.path.at(-1)!.split(".").at(-1)!.toLowerCase();
    if (entry.kind === "file" && PATTERN_FORMATS.includes(extension))
      counts.set(extension, (counts.get(extension) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([extension, count]) => ({
      path: [...path, `*.${extension}`],
      kind: "pattern",
      count,
    }));
}

interface StorageLevel {
  entries: {
    name: string;
    kind: "folder" | "file";
    size: number | null;
    modified: string | null;
  }[];
  truncated: boolean;
}

/**
 * The folders and files below a storage connection's root. A complete level is
 * loaded once and filtered here; a larger one asks the server for the names
 * starting with the filter.
 */
export function storageSource(
  worktree: string,
  connection: string,
  environment: string,
): BrowserSource {
  const complete = new Map<string, BrowserEntry[]>();
  return async (path, filter, signal) => {
    const folder = path.join("/");
    const known = complete.get(folder);
    if (known) {
      const entries = known.filter((entry) =>
        contains(entry.path.at(-1)!, filter),
      );
      return {
        entries: filter.trim() ? entries : withPatterns(path, entries),
        truncated: false,
      };
    }
    // Typing narrows a large level on the server: wait for a pause between keys.
    if (filter.trim()) await pause(200, signal);
    const level = await api<StorageLevel>(
      withQuery(
        `/worktrees/${worktree}/connections/${encodeURIComponent(connection)}/files`,
        { environment, path: folder, prefix: filter.trim() || undefined },
      ),
      { signal },
    );
    const entries: BrowserEntry[] = level.entries.map((entry) => ({
      path: [...path, entry.name],
      kind: entry.kind,
      size: entry.size,
      modified: entry.modified,
    }));
    if (!filter.trim() && !level.truncated) complete.set(folder, entries);
    return {
      entries:
        filter.trim() || level.truncated
          ? entries
          : withPatterns(path, entries),
      truncated: level.truncated,
    };
  };
}

const pause = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Folders, then the patterns over the files, then the files. */
function withPatterns(path: string[], entries: BrowserEntry[]) {
  const files = entries.findIndex((entry) => entry.kind === "file");
  if (files < 0) return entries;
  return [
    ...entries.slice(0, files),
    ...filePatterns(path, entries),
    ...entries.slice(files),
  ];
}

/**
 * The schemas and tables of a database connection, already listed. A filter
 * searches every schema: the open schema's tables come first.
 */
export function databaseSource(objects: DatabaseObjects): BrowserSource {
  const table = (item: DatabaseObjects["tables"][number]): BrowserEntry => ({
    path: [item.schema, item.name],
    kind: item.view ? "view" : "table",
  });
  return async ([schema], filter) => {
    const matching = objects.tables.filter(
      (item) =>
        contains(item.name, filter) ||
        contains(`${item.schema}.${item.name}`, filter),
    );
    const here = matching.filter((item) => item.schema === schema).map(table);
    if (schema && !filter.trim())
      return { entries: here, truncated: objects.truncated };
    const schemas: BrowserEntry[] = schema
      ? []
      : objects.schemas
          .filter((name) => contains(name, filter))
          .map((name) => ({
            path: [name],
            kind: "schema",
            count: objects.tables.filter((item) => item.schema === name).length,
          }));
    const elsewhere = filter.trim()
      ? matching.filter((item) => item.schema !== schema).map(table)
      : [];
    return {
      entries: [...schemas, ...here, ...elsewhere],
      truncated: objects.truncated,
    };
  };
}

/**
 * Where the browser opens for a path already written in a file field: the
 * folder of a relative path, such as the `*.csv` pattern the browser writes,
 * or the root for an expression, a pattern over folders, an absolute path or
 * a URI.
 */
export function openingFolder(value: string): string[] {
  if (!value || /[{}\\]|^\/|^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return [];
  const folder = value.split("/").filter(Boolean).slice(0, -1);
  return folder.some((part) => /[*?[\]]/.test(part)) ? [] : folder;
}

const UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"];

/**
 * A file size with at most three significant digits, in the units of the
 * interface language: 1.2 MB in English, 1,2 Mo in French.
 */
export function fileSize(bytes: number, language: string) {
  const unit = Math.min(
    UNITS.length - 1,
    bytes < 1 ? 0 : Math.floor(Math.log(bytes) / Math.log(1000)),
  );
  const value = bytes / 1000 ** unit;
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: UNITS[unit],
    // "5 byte" reads oddly in English: bytes are spelled out.
    unitDisplay: unit ? "short" : "long",
    maximumFractionDigits: value < 10 && unit ? 1 : 0,
  }).format(value);
}
