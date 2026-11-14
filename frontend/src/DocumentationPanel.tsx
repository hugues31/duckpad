import { FileDown, Pencil } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import GeneratedDocumentation, {
  documentationSections,
} from "./GeneratedDocumentation";
import { useLanguage, useT, type TranslationKey } from "./i18n";
import MarkdownEditor from "./MarkdownEditor";
import MarkdownText from "./MarkdownText";
import {
  nodeAnchor,
  projectDocumentation,
  type ProjectDocumentation,
} from "./projectDocumentation";
import type { Environment, Snapshot, Statuses } from "./types";
import { useRevisionDraft } from "./useRevisionDraft";

/** An entry of the page outline, with the nodes of its section. */
interface OutlineEntry {
  id: string;
  label: string;
  count?: number;
  children?: { id: string; label: string }[];
}

function outline(
  documentation: ProjectDocumentation,
  t: (key: TranslationKey) => string,
): OutlineEntry[] {
  return [
    { id: "doc-overview", label: t("docOverview") },
    ...(documentation.diagram.nodes.length
      ? [{ id: "doc-pipeline", label: t("docPipeline") }]
      : []),
    ...documentationSections(documentation).map(([id, label, nodes]) => ({
      id,
      label: t(label),
      count: nodes.length,
      children: nodes.map((node) => ({
        id: nodeAnchor(node.id),
        label: node.label,
      })),
    })),
    ...(
      [
        ["doc-variables", "variables", documentation.variables],
        ["doc-tests", "docTests", documentation.tests],
        ["doc-connections", "connections", documentation.connections],
      ] as const
    ).flatMap(([id, label, items]) =>
      items.length ? [{ id, label: t(label), count: items.length }] : [],
    ),
  ];
}

/**
 * When the page started printing, from the browser's own events: the print
 * layout is also right when the user prints with the browser's shortcut.
 */
function usePrinting(title: string) {
  const [printing, setPrinting] = useState<Date | null>(null);
  useEffect(() => {
    let previous = document.title;
    const before = () => {
      previous = document.title;
      // Browsers name the saved PDF after the page title.
      document.title = title;
      // The printed page is a snapshot taken when this handler returns.
      flushSync(() => setPrinting(new Date()));
    };
    const after = () => {
      document.title = previous;
      setPrinting(null);
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, [title]);
  return printing;
}

/** What a reader does to scroll by hand, the scrollbar included. */
const RELEASES = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/**
 * The outline entry of the section being read: the last one that scrolled
 * past the top of the page. A followed link stays active until the reader
 * scrolls, since a short final section cannot reach the top.
 */
function useActiveSection(page: RefObject<HTMLElement | null>, ids: string[]) {
  const [active, setActive] = useState(ids[0]);
  const followed = useRef(false);
  const key = ids.join("\n");
  useEffect(() => {
    const root = page.current;
    if (!root) return;
    const targets = key.split("\n");
    let frame = 0;
    const update = () => {
      frame = 0;
      if (followed.current) return;
      const limit = root.getBoundingClientRect().top + 96;
      let current = targets[0];
      for (const id of targets) {
        const top = document.getElementById(id)?.getBoundingClientRect().top;
        if (top !== undefined && top <= limit) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(update);
    };
    const release = () => {
      followed.current = false;
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    for (const event of RELEASES)
      root.addEventListener(event, release, { passive: true });
    update();
    return () => {
      cancelAnimationFrame(frame);
      root.removeEventListener("scroll", onScroll);
      for (const event of RELEASES) root.removeEventListener(event, release);
    };
  }, [page, key]);
  return {
    active,
    /** Keep an entry active while the page scrolls to it; null follows the scroll again. */
    follow: (id: string | null) => {
      followed.current = id !== null;
      if (id !== null) setActive(id);
    },
  };
}

/** A CSS string, for text of the project shown by a stylesheet. */
const cssString = (text: string) =>
  `"${text.replace(/[^\p{L}\p{N} .,:;()·–-]/gu, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}"`;

/** The share of described items, for the project's authors. */
function Coverage({
  label,
  documented,
  total,
}: {
  label: string;
  documented: number;
  total: number;
}) {
  return (
    <div className="doc-coverage-item">
      <span>{label}</span>
      <span
        className="doc-meter"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={documented}
      >
        <span style={{ width: `${total ? (100 * documented) / total : 0}%` }} />
      </span>
    </div>
  );
}

/** The authored overview, saved in README.md, read by default. */
function Overview({
  readOnly,
  printing,
  snapshot,
  onSave,
}: {
  readOnly: boolean;
  printing: boolean;
  snapshot: Snapshot;
  onSave: (text: string, base: Snapshot) => Promise<Snapshot>;
}) {
  const t = useT();
  const [message, setMessage] = useState("");
  const [editing, setEditing] = useState(false);
  const { draft, update, persist, pending, dirty } = useRevisionDraft(
    snapshot.bundle?.documentation.project || "",
    snapshot,
    onSave,
  );
  const writing = editing && !readOnly && !printing;
  return (
    <section id="doc-overview" tabIndex={-1} aria-labelledby="doc-overview-h">
      <div className="doc-section-heading">
        <h2 id="doc-overview-h">{t("docOverview")}</h2>
        {!readOnly && (
          <div className="documentation-actions">
            <span className="muted small" role="status">
              {message || (dirty && !writing ? t("unsavedChanges") : "")}
            </span>
            {(writing || dirty) && (
              <button
                className="button primary small"
                disabled={!dirty || pending}
                onClick={async () => {
                  setMessage("");
                  try {
                    await persist();
                    setMessage(t("saved"));
                  } catch (e) {
                    setMessage((e as Error).message);
                  }
                }}
              >
                {t(pending ? "saving" : "save")}
              </button>
            )}
            <button
              className="button secondary small"
              onClick={() => setEditing(!writing)}
            >
              {writing ? (
                t("docDone")
              ) : (
                <>
                  <Pencil size={13} aria-hidden="true" />
                  {t("docEditOverview")}
                </>
              )}
            </button>
          </div>
        )}
      </div>
      {writing ? (
        <>
          <p className="doc-editor-hint">{t("emptyDocumentation")}</p>
          <MarkdownEditor
            value={draft}
            onChange={(text) => {
              update(() => text);
              setMessage("");
            }}
          />
        </>
      ) : draft.trim() ? (
        <div className="documentation-preview doc-prose">
          <MarkdownText headingOffset={2}>{draft}</MarkdownText>
        </div>
      ) : (
        <p className="doc-empty">
          {t(readOnly ? "docNoOverview" : "docNoOverviewHint")}
        </p>
      )}
    </section>
  );
}

export default function DocumentationPanel({
  readOnly = false,
  snapshot,
  onSave,
  statuses,
  environment,
  environments,
}: {
  readOnly?: boolean;
  snapshot: Snapshot;
  statuses: Statuses;
  /** The environment whose retained results describe the outputs. */
  environment: string;
  environments: Environment[];
  /** Save the text on top of the given revision; resolve to the saved snapshot. */
  onSave: (text: string, base: Snapshot) => Promise<Snapshot>;
}) {
  const t = useT();
  const language = useLanguage();
  const page = useRef<HTMLElement>(null);
  const documentation = useMemo(
    () => projectDocumentation(snapshot, statuses, t),
    [snapshot, statuses, t],
  );
  const entries = useMemo(
    () => (documentation ? outline(documentation, t) : []),
    [documentation, t],
  );
  const { active, follow } = useActiveSection(
    page,
    entries.flatMap((entry) => [
      entry.id,
      ...(entry.children || []).map((child) => child.id),
    ]),
  );
  const name = documentation?.name || t("projectDocs");
  const title = `${name} - ${t("documentation")}`;
  const printed = usePrinting(title);
  const printing = !!printed;
  if (!documentation) return null;

  /** Scroll to a section of the page without leaving it: drafts stay open. */
  const followAnchor = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button ||
      event.metaKey ||
      event.ctrlKey
    )
      return;
    const link = (event.target as Element).closest("a[href^='#']");
    const id = link?.getAttribute("href")?.slice(1);
    const target = id && document.getElementById(id);
    if (!target || !page.current?.contains(target)) return;
    event.preventDefault();
    // A node inside a component has no entry: the outline shows where it is.
    follow(
      entries.some(
        (entry) =>
          entry.id === id || entry.children?.some((child) => child.id === id),
      )
        ? id
        : null,
    );
    target.scrollIntoView({ block: "start" });
    target.focus({ preventScroll: true });
  };
  const stats = (
    [
      ["doc-sources", "sources", documentation.sources.length],
      [
        "doc-transformations",
        "transforms",
        documentation.transformations.length,
      ],
      ["doc-exports", "exports", documentation.exports.length],
      ["doc-tests", "docTests", documentation.tests.length],
      ["doc-variables", "variables", documentation.variables.length],
      ["doc-connections", "connections", documentation.connections.length],
    ] as const
  ).filter(([, , count]) => count);
  const { coverage } = documentation;
  return (
    <section
      className="full-panel documentation-page"
      ref={page}
      onClick={followAnchor}
    >
      {/* Printed pages name the document in their footer. */}
      <style>{`@media print { @page { @bottom-left { content: ${cssString(title)}; color: #6b6b76; font-size: 9px; } } }`}</style>
      <div className="doc-layout">
        <nav className="doc-outline" aria-label={t("docContents")}>
          <p className="eyebrow">{t("docContents")}</p>
          <ul>
            {entries.map((entry) => {
              const open =
                entry.id === active ||
                !!entry.children?.some((child) => child.id === active);
              return (
                <li key={entry.id}>
                  <a
                    href={"#" + entry.id}
                    aria-current={entry.id === active ? "location" : undefined}
                    className={open ? "is-open" : ""}
                  >
                    {entry.label}
                    {entry.count !== undefined && <small>{entry.count}</small>}
                  </a>
                  {!!entry.children?.length && (
                    <ul>
                      {entry.children.map((child) => (
                        <li key={child.id}>
                          <a
                            href={"#" + child.id}
                            aria-current={
                              child.id === active ? "location" : undefined
                            }
                          >
                            {child.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="doc-article">
          <header className="doc-cover">
            <div className="doc-cover-title">
              <div>
                <span className="eyebrow">{t("projectDocs")}</span>
                <h1>{documentation.name}</h1>
                {documentation.description && (
                  <p className="doc-lede">{documentation.description}</p>
                )}
              </div>
              <button
                className="button secondary doc-export"
                onClick={() => window.print()}
                title={t("docExportHint")}
              >
                <FileDown size={15} aria-hidden="true" />
                {t("docExport")}
              </button>
            </div>
            <p className="doc-print-meta">
              {[
                `${t("branch")} ${snapshot.worktree.branch}`,
                `${t("commit")} ${snapshot.commit.slice(0, 8)}`,
                `${t("environment")} ${
                  environments.find((item) => item.id === environment)?.label ||
                  environment
                }`,
                ...(printed
                  ? [
                      t("docGenerated").replace(
                        "{date}",
                        printed.toLocaleString(language, {
                          dateStyle: "long",
                          timeStyle: "short",
                        }),
                      ),
                    ]
                  : []),
              ].join("  ·  ")}
            </p>
            {!!stats.length && (
              <ul className="doc-stats">
                {stats.map(([id, label, count]) => (
                  <li key={id}>
                    <a href={"#" + id}>
                      <strong>{count.toLocaleString(language)}</strong>
                      {t(label)}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && !!coverage.nodes.total && (
              <div className="doc-coverage">
                <span className="eyebrow">{t("docCoverage")}</span>
                <Coverage
                  label={t("docCoverageNodes")
                    .replace("{documented}", String(coverage.nodes.documented))
                    .replace("{total}", String(coverage.nodes.total))}
                  {...coverage.nodes}
                />
                {!!coverage.columns.total && (
                  <Coverage
                    label={t("docCoverageColumns")
                      .replace(
                        "{documented}",
                        String(coverage.columns.documented),
                      )
                      .replace("{total}", String(coverage.columns.total))}
                    {...coverage.columns}
                  />
                )}
              </div>
            )}
          </header>
          <Overview
            readOnly={readOnly}
            printing={printing}
            snapshot={snapshot}
            onSave={onSave}
          />
          {documentation.diagram.nodes.length ? (
            <GeneratedDocumentation
              documentation={documentation}
              environments={environments}
              worktree={snapshot.worktree.id}
              environment={environment}
              printing={printing}
            />
          ) : (
            <p className="doc-empty">{t("docNoNodes")}</p>
          )}
          <footer className="doc-footnote">
            {t("generatedDocumentationHint")}
          </footer>
        </div>
      </div>
    </section>
  );
}
