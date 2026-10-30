import { useEffect, useRef, useState } from "react";
import { api, withQuery } from "./api";
import ComparisonView from "./ComparisonView";
import { TabStatus } from "./gitTabs";
import { useT } from "./i18n";
import Select from "./Select";
import type { Json } from "./types";

/**
 * The revisions chosen for a comparison, as the user names them. `pinned`
 * reuses frozen revisions already resolved, so swapping A and B or capturing
 * the working files again keeps the other side unchanged.
 */
export interface Selection {
  a: string;
  b: string;
  pinned?: { a?: string; b?: string };
}

interface History {
  items: Json[];
  head: string;
  next: number | null;
}

type Resolved = { selection: Selection; a: string; b: string } | null;

/** Revisions already resolved for this exact selection, if any. */
const frozenFor = (resolved: Resolved, selection: Selection) =>
  resolved?.selection === selection ? resolved : selection.pinned;

const selectionKey = (storageKey: string) => `${storageKey}.selection`;

/** The last chosen names, resolved again on every opening. */
export function savedSelection(storageKey: string): Selection {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(selectionKey(storageKey)) || "{}",
    );
    return {
      a: typeof value.a === "string" ? value.a : "HEAD",
      b: typeof value.b === "string" ? value.b : "working",
    };
  } catch {
    return { a: "HEAD", b: "working" };
  }
}

export default function GitCompareTab({
  base,
  storageKey,
  selection,
  ready,
  branches,
  entity: initialEntity = "",
  version,
  onSelect,
}: {
  base: string;
  storageKey: string;
  selection: Selection;
  /** False while the revisions to open with are still being resolved. */
  ready: boolean;
  branches: Json[];
  entity?: string;
  /** Changes whenever a Git action may have changed the history. */
  version: number;
  onSelect: (selection: Selection) => void;
}) {
  const t = useT();
  const [report, setReport] = useState<Json | null>(null);
  const [comparing, setComparing] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const resolved = useRef<Resolved>(null);
  const [entity, setEntity] = useState(initialEntity);
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState<{
    message: string;
    retry: () => void;
  } | null>(null);
  const [historyAttempt, setHistoryAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const frozen = frozenFor(resolved.current, selection);
    setComparing(true);
    setError("");
    api<Json>(
      withQuery(`${base}/compare`, {
        a: frozen?.a || selection.a,
        b: frozen?.b || selection.b,
      }),
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        resolved.current = { selection, a: result.a.ref, b: result.b.ref };
        setReport(result);
        setComparing(false);
        // Resolved revisions go stale and frozen ones expire: only names are kept.
        sessionStorage.setItem(
          selectionKey(storageKey),
          JSON.stringify({ a: selection.a, b: selection.b }),
        );
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setError(e.message);
        setComparing(false);
      });
    return () => controller.abort();
  }, [base, storageKey, selection, ready, attempt]);

  useEffect(() => {
    const controller = new AbortController();
    setHistoryError(null);
    api<History>(
      withQuery(`${base}/history`, { entity: entity || undefined }),
      { signal: controller.signal },
    )
      .then((page) => {
        if (!controller.signal.aborted) setHistory(page);
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setHistoryError({
            message: e.message,
            retry: () => setHistoryAttempt((value) => value + 1),
          });
      });
    return () => controller.abort();
  }, [base, entity, version, historyAttempt]);

  async function loadMore() {
    if (!history || history.next === null) return;
    const from = history;
    setLoadingMore(true);
    setHistoryError(null);
    try {
      const page = await api<History>(
        withQuery(`${base}/history`, {
          ref: from.head,
          offset: from.next!,
          entity: entity || undefined,
        }),
      );
      // A history reloaded meanwhile is not extended with an older page.
      setHistory((current) =>
        current === from
          ? { ...page, items: [...from.items, ...page.items] }
          : current,
      );
    } catch (e) {
      setHistoryError({ message: (e as Error).message, retry: loadMore });
    } finally {
      setLoadingMore(false);
    }
  }

  const items = history?.items || [];
  const currentCommit = items.find((v) => v.commit === selection.b);

  return (
    <>
      <div className="git-revisions">
        {(["a", "b"] as const).map((side) => (
          <label key={side}>
            <strong>{t(side === "a" ? "referenceA" : "targetB")}</strong>
            <input
              aria-label={t(side === "a" ? "referenceA" : "targetB")}
              list="git-revision-list"
              value={selection[side]}
              onChange={({ target: { value } }) =>
                onSelect(
                  side === "a"
                    ? { a: value, b: selection.b }
                    : { a: selection.a, b: value },
                )
              }
            />
            {report?.[side] && (
              <small>
                {report[side].name} ·{" "}
                <code>{report[side].commit?.slice(0, 12) || "—"}</code> ·{" "}
                {report[side].author} ·{" "}
                {report[side].date
                  ? new Date(report[side].date).toLocaleString()
                  : ""}
                {report[side].captured &&
                  ` · ${t("frozenAt")} ${new Date(report[side].captured).toLocaleString()}`}
              </small>
            )}
          </label>
        ))}
        <datalist id="git-revision-list">
          <option value="working">{t("workingFiles")}</option>
          <option value="HEAD" />
          <option value="empty">{t("emptyTree")}</option>
          {branches.map((v) => (
            <option key={v.ref} value={v.ref}>
              {v.name}
            </option>
          ))}
          {items.map((v) => (
            <option key={v.commit} value={v.commit}>
              {v.message}
            </option>
          ))}
        </datalist>
        <button
          className="button secondary"
          onClick={() => {
            const frozen = frozenFor(resolved.current, selection);
            onSelect({
              a: selection.b,
              b: selection.a,
              pinned: { a: frozen?.b, b: frozen?.a },
            });
          }}
        >
          {t("swapAB")}
        </button>
        <button
          className="button secondary"
          onClick={() =>
            onSelect({
              a: selection.a,
              b: "working",
              pinned: { a: frozenFor(resolved.current, selection)?.a },
            })
          }
        >
          {t("captureWorking")}
        </button>
      </div>
      {currentCommit && currentCommit.parents.length > 1 && (
        <label>
          {t("actualParent")}{" "}
          <Select
            value={selection.a}
            onChange={(e) => onSelect({ a: e.target.value, b: selection.b })}
          >
            {currentCommit.parents.map((parent: string) => (
              <option key={parent} value={parent}>
                {parent.slice(0, 12)}
              </option>
            ))}
          </Select>
        </label>
      )}
      <details className="git-history" open={!!entity}>
        <summary>
          {t("gitHistory")}
          {entity ? ` · ${entity}` : ""}
        </summary>
        <label>
          {t("elementHistory")}{" "}
          <input
            aria-label={t("historyEntity")}
            list="git-entities"
            value={entity}
            onChange={(e) => setEntity(e.target.value)}
            placeholder={t("allElements")}
          />
        </label>
        <datalist id="git-entities">
          {report?.entities
            .filter((v: Json) =>
              ["node", "template", "component"].includes(v.kind),
            )
            .map((v: Json) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
        </datalist>
        {items.map((item) => (
          <div className="git-commit" key={item.commit}>
            <div>
              <strong>{item.message}</strong>
              <small>
                {item.author} · {new Date(item.date).toLocaleString()} ·{" "}
                {item.commit.slice(0, 12)}
              </small>
            </div>
            <button
              className="button secondary small"
              onClick={() =>
                onSelect({ a: item.parents[0] || "empty", b: item.commit })
              }
            >
              {t("compareParent")}
            </button>
            <button
              className="button secondary small"
              onClick={() => onSelect({ a: item.commit, b: selection.b })}
            >
              A
            </button>
            <button
              className="button secondary small"
              onClick={() => onSelect({ a: selection.a, b: item.commit })}
            >
              B
            </button>
          </div>
        ))}
        <TabStatus
          error={historyError?.message}
          onRetry={historyError?.retry}
        />
        {history && history.next !== null && !historyError && (
          <button
            className="button secondary"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {t(loadingMore ? "loading" : "loadMore")}
          </button>
        )}
      </details>
      {error ? (
        <TabStatus
          error={error}
          onRetry={() => setAttempt((value) => value + 1)}
        />
      ) : comparing || !ready ? (
        <p role="status">{t("comparing")}</p>
      ) : (
        report && (
          <ComparisonView
            report={report}
            storageKey={storageKey + ".filters"}
            onHistory={setEntity}
          />
        )
      )}
    </>
  );
}
