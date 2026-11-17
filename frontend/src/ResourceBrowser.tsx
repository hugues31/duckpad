import {
  Asterisk,
  Check,
  ChevronRight,
  Database,
  Eye,
  File,
  Folder,
  HardDrive,
  Layers,
  Search,
  Table2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { countLabel, useLanguage, useT } from "./i18n";
import { Modal } from "./modals";
import {
  fileSize,
  isContainer,
  type BrowserEntry,
  type BrowserLevel,
  type BrowserSource,
} from "./resourceBrowsing";
import { useResource } from "./useApiResource";

const ICONS = {
  folder: Folder,
  file: File,
  pattern: Asterisk,
  schema: Layers,
  table: Table2,
  view: Eye,
};

/**
 * Browse what a connection holds and choose one entry: a file below a storage
 * root, or a table of a database. Both are the same dialog over a different
 * source, so every node whose parameters name a connection gets it.
 */
export default function ResourceBrowser({
  title,
  root,
  family,
  source,
  initialPath = [],
  current,
  onChoose,
  onChooseFolder,
  onClose,
}: {
  title: string;
  /** The connection's display name, the first step of the path. */
  root: string;
  family: "storage" | "database";
  source: BrowserSource;
  initialPath?: string[];
  /** The entry already chosen, marked and reached first. */
  current?: string[];
  onChoose: (entry: BrowserEntry) => void;
  /** Offers the open folder itself, for readers of a table folder. */
  onChooseFolder?: (path: string[]) => void;
  onClose: () => void;
}) {
  const t = useT();
  const language = useLanguage();
  const listId = useId();
  const [path, setPath] = useState(initialPath);
  const [filter, setFilter] = useState("");
  // The entry reached first in the open container: the chosen one, or the folder just left.
  const [anchor, setAnchor] = useState(current?.at(-1));
  const [moved, setMoved] = useState<{ key: string; index: number }>();
  const key = JSON.stringify([path, filter]);
  const loaded = useResource(key, (signal) => source(path, filter, signal));
  // The previous entries stay in place, dimmed, until the next ones arrive.
  const [shown, setShown] = useState<BrowserLevel | null>(null);
  if (loaded.data && loaded.data !== shown) setShown(loaded.data);
  const entries = loaded.error ? [] : (shown?.entries ?? []);
  const anchored = entries.findIndex((entry) => entry.path.at(-1) === anchor);
  const active = Math.min(
    moved?.key === key ? moved.index : Math.max(0, anchored),
    Math.max(0, entries.length - 1),
  );
  const storage = family === "storage";
  const date = new Intl.DateTimeFormat(language, { dateStyle: "medium" });
  const open = (next: string[], reach?: string) => {
    setPath(next);
    setFilter("");
    setAnchor(reach);
  };
  const activate = (entry?: BrowserEntry) => {
    if (!entry || loaded.pending) return;
    if (isContainer(entry)) open(entry.path);
    else onChoose(entry);
  };
  useEffect(() => {
    document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, listId, shown]);
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((part, index) => part === b[index]);
  const detail = (entry: BrowserEntry) => {
    if (entry.kind === "schema")
      return countLabel(
        t,
        entry.count ?? 0,
        "browseTableOne",
        "browseTableCount",
      );
    if (entry.kind === "pattern")
      return countLabel(
        t,
        entry.count ?? 0,
        "browseFileOne",
        "browseFileCount",
      );
    if (entry.kind === "view") return t("browseView");
    return [
      entry.size == null ? "" : fileSize(entry.size, language),
      entry.modified ? date.format(new Date(entry.modified)) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  return createPortal(
    <Modal title={title} onClose={onClose}>
      <div className="resource-browser">
        <div className="search">
          <Search size={15} aria-hidden="true" />
          <input
            data-autofocus
            role="combobox"
            aria-label={t(storage ? "browseFilterFiles" : "browseFilterTables")}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={
              entries.length ? `${listId}-${active}` : undefined
            }
            placeholder={t(
              storage ? "browseFilterFiles" : "browseFilterTables",
            )}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (entries.length)
                  setMoved({
                    key,
                    index:
                      (active +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        entries.length) %
                      entries.length,
                  });
              } else if (event.key === "Enter") {
                event.preventDefault();
                activate(entries[active]);
              } else if (event.key === "Backspace" && !filter && path.length) {
                event.preventDefault();
                open(path.slice(0, -1), path.at(-1));
              }
            }}
          />
        </div>
        <nav className="resource-path" aria-label={t("browsePath")}>
          {[root, ...path].map((name, depth) => (
            <span key={depth}>
              {depth > 0 && <ChevronRight size={13} aria-hidden="true" />}
              <button
                type="button"
                aria-current={depth === path.length ? "location" : undefined}
                disabled={depth === path.length}
                onClick={() => open(path.slice(0, depth), path[depth])}
              >
                {depth === 0 &&
                  (storage ? (
                    <HardDrive size={13} aria-hidden="true" />
                  ) : (
                    <Database size={13} aria-hidden="true" />
                  ))}
                {name}
              </button>
            </span>
          ))}
        </nav>
        <div
          id={listId}
          role="listbox"
          aria-label={title}
          aria-busy={loaded.pending}
          className="resource-entries"
        >
          {entries.map((entry, index) => {
            const Icon = ICONS[entry.kind];
            const name = entry.path.at(-1)!;
            const parent = entry.path.slice(0, -1);
            return (
              <button
                key={entry.path.join("/")}
                id={`${listId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === active}
                tabIndex={-1}
                className={`resource-entry ${entry.kind}`}
                onPointerMove={() => {
                  if (index !== active) setMoved({ key, index });
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => activate(entry)}
              >
                <Icon size={16} aria-hidden="true" />
                <span className="resource-entry-name">
                  {entry.kind === "pattern" ? (
                    <>
                      {t("browseAllFiles").replace(
                        "{format}",
                        name.slice(2).toUpperCase(),
                      )}
                      <code>{name}</code>
                    </>
                  ) : (
                    <>
                      {!same(parent, path) && (
                        <span className="resource-entry-context">
                          {parent.join(".")}.
                        </span>
                      )}
                      {name}
                    </>
                  )}
                </span>
                <span className="resource-entry-detail">{detail(entry)}</span>
                {current && same(entry.path, current) ? (
                  <Check size={15} aria-label={t("browseCurrent")} />
                ) : (
                  isContainer(entry) && (
                    <ChevronRight size={15} aria-hidden="true" />
                  )
                )}
              </button>
            );
          })}
          {loaded.error ? (
            <div className="resource-status">
              <p className="notice error" role="alert">
                {loaded.error}
              </p>
              <button
                type="button"
                className="button secondary small"
                onClick={loaded.reload}
              >
                {t("retry")}
              </button>
            </div>
          ) : !shown ? (
            <p className="resource-status" role="status">
              {t("loading")}
            </p>
          ) : (
            !entries.length &&
            !loaded.pending && (
              <p className="resource-status" role="status">
                {t(
                  filter
                    ? "browseNoMatch"
                    : storage
                      ? "browseEmptyFolder"
                      : "browseEmptySchema",
                )}
              </p>
            )
          )}
        </div>
        {shown?.truncated && !loaded.error && (
          <p className="resource-truncated">
            {t(storage ? "browseTruncatedFiles" : "browseTruncatedTables")}
          </p>
        )}
      </div>
      <footer>
        {onChooseFolder && (
          <button
            type="button"
            className="text-button resource-folder-choice"
            disabled={!path.length || loaded.pending || !!loaded.error}
            onClick={() => onChooseFolder(path)}
          >
            {t("browseUseFolder")}
          </button>
        )}
        <button type="button" className="button secondary" onClick={onClose}>
          {t("cancel")}
        </button>
      </footer>
    </Modal>,
    document.body,
  );
}
