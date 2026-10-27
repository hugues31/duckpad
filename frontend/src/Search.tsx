import { useEffect, useId, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { useNavigate } from "react-router";
import { api, withQuery } from "./api";
import { useT } from "./i18n";
import { Modal } from "./modals";
import { worktreeUrl } from "./navigation";
import type { Workspace } from "./types";

export interface SearchOption {
  key: string;
  label: string;
  detail: string;
}

/** Keyboard navigation stays in the input; result selection never edits a graph. */
export function SearchField({
  label,
  query,
  onQuery,
  options,
  onSelect,
  pending = false,
  message,
  autoFocus = false,
}: {
  label: string;
  query: string;
  onQuery: (value: string) => void;
  options: SearchOption[];
  onSelect: (index: number) => void;
  pending?: boolean;
  message?: string;
  autoFocus?: boolean;
}) {
  const t = useT();
  const id = useId();
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const expanded = open && !!query.trim();
  const index = Math.min(active, Math.max(0, options.length - 1));
  useEffect(() => {
    list.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index]);
  const choose = (index: number) => {
    onSelect(index);
    setOpen(false);
  };
  return (
    <div
      className="search-field"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="search">
        {pending ? (
          <Loader2 size={16} className="spin" />
        ) : (
          <Search size={16} />
        )}
        <input
          ref={input}
          autoFocus={autoFocus}
          role="combobox"
          aria-label={label}
          placeholder={label}
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? id : undefined}
          aria-activedescendant={
            expanded && options.length ? `${id}-${index}` : undefined
          }
          maxLength={200}
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            onQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              return;
            }
            if (["ArrowDown", "ArrowUp"].includes(event.key)) {
              event.preventDefault();
              setOpen(true);
              setActive(
                (index +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  options.length) %
                  Math.max(1, options.length),
              );
            }
            if (event.key === "Enter" && expanded && options.length) {
              event.preventDefault();
              choose(index);
            }
          }}
        />
        {query && (
          <button
            className="icon"
            aria-label={t("clearSearch")}
            onClick={() => {
              onQuery("");
              setActive(0);
              input.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="search-dropdown">
          <div id={id} role="listbox" aria-label={label} ref={list}>
            {options.map((option, i) => (
              <div
                key={option.key}
                id={`${id}-${i}`}
                role="option"
                aria-selected={index === i}
                className="search-result"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(i)}
              >
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </div>
            ))}
          </div>
          <p className="search-status" role="status">
            {pending
              ? t("loading")
              : message ||
                (options.length
                  ? `${t("searchResults")}: ${options.length}`
                  : t("noSearchResults"))}
          </p>
        </div>
      )}
    </div>
  );
}

interface SearchResult {
  kind: "project" | "branch" | "node";
  label: string;
  project: string;
  project_name: string;
  worktree: string;
  branch: string;
  node?: string;
  path?: string[];
  breadcrumbs?: string[];
}
interface SearchResponse {
  results: SearchResult[];
  has_more: boolean;
  incomplete: boolean;
}

export default function InstanceSearch({
  workspace,
  environment,
  onClose,
  onExpired,
}: {
  workspace: Workspace;
  environment: string;
  onClose: () => void;
  onExpired: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement as HTMLElement);
  const scope = workspace.projects.map((p) => `${p.id}:${p.role}`).join("|");
  useEffect(() => {
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = container.current?.closest("[role=dialog]");
      const controls = dialog?.querySelectorAll<HTMLElement>("button, input");
      if (!controls?.length) return;
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      returnFocus.current?.focus();
    };
  }, []);
  useEffect(() => {
    setResponse(null);
    setError("");
    if (!query.trim()) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const search = async () => {
      try {
        const result = await api<SearchResponse>(
          withQuery("/search", { q: query.trim() }),
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setResponse(result);
          setError("");
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        setResponse(null);
        setError((e as Error).message);
        if ((e as { status?: number }).status === 401) onExpired();
      }
      // Refresh open results so membership revocations do not linger in the UI.
      if (!controller.signal.aborted) timer = setTimeout(search, 5000);
    };
    timer = setTimeout(search, 200);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, scope, onExpired]);
  const results = (response?.results || []).filter((result) =>
    workspace.projects.some((project) => project.id === result.project),
  );
  return (
    <Modal title={t("instanceSearch")} onClose={onClose}>
      <div className="modal-content instance-search" ref={container}>
        <p>{t("instanceSearchHint")}</p>
        <SearchField
          autoFocus
          label={t("instanceSearch")}
          query={query}
          onQuery={(value) => {
            setQuery(value);
            setResponse(null);
            setError("");
          }}
          pending={!!query.trim() && !response && !error}
          message={
            error ||
            (response?.incomplete
              ? t("searchIncomplete")
              : response?.has_more
                ? t("searchMore")
                : undefined)
          }
          options={results.map((result, index) => ({
            key: String(index),
            label: result.label,
            detail: [
              t(
                result.kind === "node"
                  ? "node"
                  : result.kind === "branch"
                    ? "branch"
                    : "project",
              ),
              result.project_name,
              result.branch,
              ...(result.breadcrumbs || []),
              result.node,
            ]
              .filter(Boolean)
              .join(" · "),
          }))}
          onSelect={(index) => {
            const result = results[index];
            const url = worktreeUrl(result.worktree, "flow", environment);
            const node = result.node
              ? `&${new URLSearchParams({ node: [...(result.path || []), result.node].join("::") })}`
              : "";
            void navigate(url + node, { state: { searchResult: true } });
            onClose();
          }}
        />
      </div>
    </Modal>
  );
}
