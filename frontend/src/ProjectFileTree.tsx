import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  Folder,
  FolderOpen,
} from "lucide-react";
import { useT } from "./i18n";

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

export default function ProjectFileTree({
  files,
  selected,
  onSelect,
}: {
  files: Record<string, string>;
  selected: string;
  onSelect: (path: string) => void;
}) {
  const t = useT();
  const entries = useMemo(() => fileTree(Object.keys(files)), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState(selected);
  const tree = useRef<HTMLDivElement>(null);
  const visible: Entry[] = [];
  const visit = (items: Entry[]) =>
    items.forEach((entry) => {
      visible.push(entry);
      if (!collapsed.has(entry.path)) visit(entry.children);
    });
  visit(entries);
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
  const toggle = (path: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
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
        if (folder && collapsed.has(entry.path)) toggle(entry.path);
        else if (folder) focus(entry.children[0]?.path);
        break;
      case "ArrowLeft":
        if (folder && !collapsed.has(entry.path)) toggle(entry.path);
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
      const expanded = !collapsed.has(entry.path);
      const Icon = folder ? (expanded ? FolderOpen : Folder) : FileCode2;
      const Chevron = expanded ? ChevronDown : ChevronRight;
      return (
        <div
          key={entry.path}
          role="treeitem"
          aria-label={entry.path}
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
            <Icon size={15} />
            <span>{entry.name}</span>
          </div>
          {folder && expanded && (
            <div role="group">{render(entry.children, level + 1)}</div>
          )}
        </div>
      );
    });
  return (
    <div
      ref={tree}
      role="tree"
      aria-label={t("files")}
      className="project-file-tree"
    >
      {render(entries)}
    </div>
  );
}
