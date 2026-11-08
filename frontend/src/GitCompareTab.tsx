import { useEffect, useMemo, useRef, useState } from "react";
import { api, withQuery } from "./api";
import CommitRow from "./CommitRow";
import ComparisonView from "./ComparisonView";
import { TabStatus } from "./gitTabs";
import type { Branch, Comparison, GitTag } from "./gitTypes";
import { useT } from "./i18n";
import Select from "./Select";
import { useApiResource } from "./useApiResource";
import { useGitHistory } from "./useGitHistory";

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
  branches: Branch[];
  entity?: string;
  /** Changes whenever a Git action may have changed the history. */
  version: number;
  onSelect: (selection: Selection) => void;
}) {
  const t = useT();
  const tags = useApiResource<GitTag[]>(`${base}/tags`, { refresh: version });
  // The previous report stays in place while another comparison loads.
  const [report, setReport] = useState<Comparison | null>(null);
  const [attempt, setAttempt] = useState(0);
  const comparison = useMemo(
    () => ({ base, storageKey, selection, attempt }),
    [base, storageKey, selection, attempt],
  );
  // Each comparison is settled by its own answer.
  const [settled, setSettled] = useState<{
    comparison: typeof comparison;
    error: string;
  } | null>(null);
  const comparing = ready && settled?.comparison !== comparison;
  const error = settled?.comparison === comparison ? settled.error : "";
  const resolved = useRef<Resolved>(null);
  const [entity, setEntity] = useState(initialEntity);
  const gitHistory = useGitHistory(`${base}/history`, {
    entity,
    refresh: version,
    delay: 300,
  });
  const history = gitHistory.data;
  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    const { base, storageKey, selection } = comparison;
    const frozen = frozenFor(resolved.current, selection);
    const timer = window.setTimeout(() => {
      void api<Comparison>(
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
          setSettled({ comparison, error: "" });
          // Resolved revisions go stale and frozen ones expire: only names are kept.
          sessionStorage.setItem(
            selectionKey(storageKey),
            JSON.stringify({ a: selection.a, b: selection.b }),
          );
        })
        .catch((e) => {
          if (!controller.signal.aborted)
            setSettled({ comparison, error: e.message });
        });
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [comparison, ready]);

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
                {report[side].author}
                {report[side].assistant
                  ? ` ${t("assistantAttribution")}`
                  : ""}{" "}
                ·{" "}
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
          {(tags.data || []).map((tag) => (
            <option key={tag.ref} value={tag.ref}>
              {tag.name}
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
      <TabStatus error={tags.error} onRetry={tags.reload} />
      {currentCommit && currentCommit.parents.length > 1 && (
        <label>
          {t("actualParent")}{" "}
          <Select
            value={selection.a}
            onChange={(e) => onSelect({ a: e.target.value, b: selection.b })}
          >
            {currentCommit.parents.map((parent) => (
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
            .filter((v) => ["node", "template", "component"].includes(v.kind))
            .map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
        </datalist>
        {items.map((item) => (
          <CommitRow key={item.commit} commit={item} comparison>
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
          </CommitRow>
        ))}
        <TabStatus error={gitHistory.error} onRetry={gitHistory.retry} />
        {history && history.next !== null && !gitHistory.error && (
          <button
            className="button secondary"
            disabled={gitHistory.loadingMore}
            onClick={() => void gitHistory.loadMore()}
          >
            {t(gitHistory.loadingMore ? "loading" : "loadMore")}
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
