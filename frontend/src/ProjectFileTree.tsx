import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  Search,
  X,
} from "lucide-react";
import ProjectFileIcon from "./ProjectFileIcon";
import { useT } from "./i18n";
import { nodeFileLabel } from "./projectFiles";
import type { NodeNames } from "./nodeNames";

interface Entry {
  name: string;
  path: string;
  children: Entry[];
}

function fileTree(paths: string[]) {
  const root: Entry = { name: "", path: "", children: [] };
  for (const path of paths) {
    let parent = root;
    for (const name of path.split("/")) {
      let entry = parent.children.find((child) => child.name === name);
      if (!entry) {
        entry = {
          name,
          path: [parent.path, name].filter(Boolean).join("/"),
          children: [],
        };
        parent.children.push(entry);
      }
      parent = entry;
    }
  }
  const sort = (entries: Entry[]) => {
    entries.sort(
      (a, b) =>
        Number(!!b.children.length) - Number(!!a.children.length) ||
        a.name.localeCompare(b.name),
    );
    entries.forEach((entry) => sort(entry.children));
  };
  sort(root.children);
  return root.children;
}

/** Unfold the folders that contain a path, keeping the same set if none is folded. */
function reveal(collapsed: Set<string>, path: string) {
  const parts = path.split("/");
  const folders = parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
  if (!folders.some((folder) => collapsed.has(folder))) return collapsed;
  const next = new Set(collapsed);
  for (const folder of folders) next.delete(folder);
  return next;
}

export default function ProjectFileTree({
  files,
  selected,
  onSelect,
  names = {},
}: {
  files: Record<string, string>;
  selected: string;
  onSelect: (path: string) => void;
  names?: NodeNames;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [filteredCollapsed, setFilteredCollapsed] = useState(new Set<string>());
  const input = useRef<HTMLInputElement>(null);
  const filtering = !!query.trim();
  const matches = useMemo(() => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/);
    return Object.keys(files).filter((path) => {
      const text =
        `${path} ${nodeFileLabel(path, names, t) ?? ""}`.toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    });
  }, [files, names, query, t]);
  const entries = useMemo(() => fileTree(matches), [matches]);
  // Built-in templates start folded, except around the opened file.
  const [collapsed, setCollapsed] = useState<Set<string>>(() =>
    reveal(new Set(["templates"]), selected),
  );
  // A file opened from elsewhere, such as the canvas, unfolds its folders once;
  // folding them again afterwards is the user's choice.
  const [revealed, setRevealed] = useState(selected);
  if (revealed !== selected && reveal(collapsed, selected) !== collapsed) {
    setRevealed(selected);
    setCollapsed(reveal(collapsed, selected));
  }
  const [focused, setFocused] = useState(selected);
  const folded = filtering ? filteredCollapsed : collapsed;
  const tree = useRef<HTMLDivElement>(null);
  const visible: Entry[] = [];
  const visit = (items: Entry[]) =>
    items.forEach((entry) => {
      visible.push(entry);
      if (!folded.has(entry.path)) visit(entry.children);
    });
  visit(entries);
  const firstFile = visible.find((entry) => !entry.children.length)?.path;
  const focusable = visible.some((entry) => entry.path === focused)
    ? focused
    : visible[0]?.path;
  const focus = (path?: string) => {
    if (!path) return;
    setFocused(path);
    const items =
      tree.current?.querySelectorAll<HTMLDivElement>("[role=treeitem]");
    Array.from(items || [])
      .find((item) => item.dataset.path === path)
      ?.focus();
  };
  const toggle = (path: string) => {
    setRevealed(selected);
    (filtering ? setFilteredCollapsed : setCollapsed)((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const keyDown = (event: KeyboardEvent, entry: Entry) => {
    if (event.target !== event.currentTarget) return;
    const index = visible.indexOf(entry);
    const folder = !!entry.children.length;
    switch (event.key) {
      case "Enter":
      case " ":
        if (folder) toggle(entry.path);
        else onSelect(entry.path);
        break;
      case "ArrowDown":
        focus(visible[index + 1]?.path);
        break;
      case "ArrowUp":
        focus(visible[index - 1]?.path);
        break;
      case "Home":
        focus(visible[0]?.path);
        break;
      case "End":
        focus(visible.at(-1)?.path);
        break;
      case "ArrowRight":
        if (folder && folded.has(entry.path)) toggle(entry.path);
        else if (folder) focus(entry.children[0]?.path);
        break;
      case "ArrowLeft":
        if (folder && !folded.has(entry.path)) toggle(entry.path);
        else focus(entry.path.split("/").slice(0, -1).join("/"));
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const render = (items: Entry[], level = 1) =>
    items.map((entry) => {
      const folder = !!entry.children.length;
      const expanded = !folded.has(entry.path);
      const Icon = expanded ? FolderOpen : Folder;
      const Chevron = expanded ? ChevronDown : ChevronRight;
      const label = folder ? null : nodeFileLabel(entry.path, names, t);
      return (
        <div
          key={entry.path}
          role="treeitem"
          aria-label={label ?? entry.path}
          aria-level={level}
          aria-expanded={folder ? expanded : undefined}
          aria-selected={!folder && selected === entry.path}
          tabIndex={entry.path === focusable ? 0 : -1}
          data-path={entry.path}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setFocused(entry.path);
          }}
          onKeyDown={(event) => keyDown(event, entry)}
        >
          <div
            className="file-tree-row"
            title={entry.path}
            style={{ paddingLeft: 10 + (level - 1) * 18 }}
            onClick={() => {
              focus(entry.path);
              if (folder) toggle(entry.path);
              else onSelect(entry.path);
            }}
          >
            {folder ? (
              <Chevron size={13} />
            ) : (
              <span className="file-tree-indent" />
            )}
            {folder ? (
              <Icon size={15} aria-hidden="true" />
            ) : (
              <ProjectFileIcon path={entry.path} />
            )}
            <span>{label ?? entry.name}</span>
          </div>
          {folder && expanded && (
            <div role="group">{render(entry.children, level + 1)}</div>
          )}
        </div>
      );
    });
  return (
    <>
      <div className="search file-filter">
        <Search size={15} aria-hidden="true" />
        <input
          ref={input}
          type="search"
          aria-label={t("filterFiles")}
          placeholder={t("filterFiles")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setFilteredCollapsed(new Set());
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
            else if (event.key === "ArrowDown") {
              event.preventDefault();
              focus(visible[0]?.path);
            } else if (event.key === "Enter" && firstFile) {
              event.preventDefault();
              onSelect(firstFile);
              focus(firstFile);
            }
          }}
        />
        {query && (
          <button
            className="icon"
            aria-label={t("clearSearch")}
            onClick={() => {
              setQuery("");
              input.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      <div
        ref={tree}
        role="tree"
        aria-label={t("files")}
        className="project-file-tree"
      >
        {render(entries)}
      </div>
      {filtering && !matches.length && (
        <p className="file-filter-empty muted" role="status">
          {t("noSearchResults")}
        </p>
      )}
    </>
  );
}
