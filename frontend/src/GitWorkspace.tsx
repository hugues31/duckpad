import { useCallback, useEffect, useRef, useState } from "react";
import { api, send, withQuery } from "./api";
import ComparisonView from "./ComparisonView";
import { useT } from "./i18n";
import { Modal } from "./modals";
import Select from "./Select";
import type { Json } from "./types";
import "./git.css";

type Mode = "compare" | "branches" | "sync" | "review";

export default function GitWorkspace({
  worktree,
  role,
  mode = "compare",
  commit,
  entity,
  onClose,
  onChanged,
  onOpen,
}: {
  worktree: string;
  role: string;
  mode?: Mode;
  commit?: string;
  entity?: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpen: (id: string) => void;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const base = `/worktrees/${worktree}/git`;
  const savedKey = `duckpad.git.${worktree}`;
  const [saved] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(savedKey) || "{}");
    } catch {
      return {};
    }
  });
  const [tab, setTab] = useState<Mode>(mode);
  const [a, setA] = useState(commit ? `${commit}^` : saved.a || "HEAD");
  const [b, setB] = useState(commit || saved.b || "working");
  const [report, setReport] = useState<Json | null>(null);
  const [branches, setBranches] = useState<Json[]>([]);
  const [remote, setRemote] = useState<Json | null>(null);
  const [url, setUrl] = useState("");
  const [mapping, setMapping] = useState("");
  const [history, setHistory] = useState<Json[]>([]);
  const [historyHead, setHistoryHead] = useState("HEAD");
  const [next, setNext] = useState<number | null>(null);
  const [historyEntity, setHistoryEntity] = useState(entity || "");
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState(worktree);
  const [branchName, setBranchName] = useState("");
  const [revision, setRevision] = useState("HEAD");
  const [review, setReview] = useState<Json | null>(null);
  const [publication, setPublication] = useState<Json | null>(null);
  const [publishedDiff, setPublishedDiff] = useState<Json | null>(null);
  const [recreate, setRecreate] = useState(false);
  const [integrated, setIntegrated] = useState<Json | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [retry, setRetry] = useState(0);
  const comparisonSequence = useRef(0);
  const reviewSequence = useRef(0);
  const pinned = useRef<{
    a: string;
    b: string;
    left: string;
    right: string;
  } | null>(null);
  const canEdit = role !== "reader";

  useEffect(() => {
    live.current = true;
    const previous = document.activeElement as HTMLElement | null;
    const dialog = root.current?.closest<HTMLElement>("[role=dialog]");
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ),
      ].filter((el) => el.getClientRects().length);
      const first = controls[0],
        last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog?.querySelector<HTMLElement>("button")?.focus();
    document.addEventListener("keydown", key);
    return () => {
      live.current = false;
      comparisonSequence.current++;
      reviewSequence.current++;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);

  const reload = useCallback(async () => {
    const [list, status] = await Promise.all([
      api<Json[]>(`${base}/branches`),
      api<Json>(`${base}/remote`),
    ]);
    if (!live.current) return;
    setBranches(list);
    setRemote(status);
    setUrl(status.url || "");
    setMapping(status.remote_branch || status.local_branch);
    setPublication(null);
    setPublishedDiff(null);
    setSource((old) => old || list.find((v) => v.current)?.ref || "");
    if (mode === "branches")
      setDestination((old) =>
        old === worktree
          ? list.find((v) => v.name === "main")?.worktree || worktree
          : old,
      );
  }, [base, mode, worktree]);
  useEffect(() => {
    reload().catch((e) => {
      if (live.current) setError(e.message);
    });
  }, [reload]);

  useEffect(() => {
    let valid = true;
    api<Json>(
      withQuery(`${base}/history`, { entity: historyEntity || undefined }),
    )
      .then((result) => {
        if (!valid) return;
        setHistory(result.items);
        setHistoryHead(result.head);
        setNext(result.next);
        if (commit) {
          // A root commit has an empty-tree parent, and merge parents are supplied by Git.
          api<Json>(withQuery(`${base}/history`, { ref: commit, limit: 1 }))
            .then((page) => {
              if (valid) setA(page.items[0]?.parents[0] || "empty");
            })
            .catch((e) => {
              if (valid) setError(e.message);
            });
        }
      })
      .catch((e) => {
        if (valid) setError(e.message);
      });
    return () => {
      valid = false;
    };
  }, [base, historyEntity, commit]);

  useEffect(() => {
    if (tab !== "compare") return;
    const sequence = ++comparisonSequence.current;
    const controller = new AbortController();
    setComparing(true);
    setError("");
    const previous = pinned.current;
    const left =
      previous && previous.a === a && previous.b === b ? previous.left : a;
    const right =
      previous && previous.a === a && previous.b === b ? previous.right : b;
    api<Json>(withQuery(`${base}/compare`, { a: left, b: right }), {
      signal: controller.signal,
    })
      .then((result) => {
        if (!live.current || sequence !== comparisonSequence.current) return;
        pinned.current = { a, b, left: result.a.ref, right: result.b.ref };
        setReport(result);
        sessionStorage.setItem(
          savedKey,
          JSON.stringify({ a: result.a.ref, b: result.b.ref }),
        );
      })
      .catch((e) => {
        if (
          e.name !== "AbortError" &&
          live.current &&
          sequence === comparisonSequence.current
        )
          setError(e.message);
      })
      .finally(() => {
        if (live.current && sequence === comparisonSequence.current)
          setComparing(false);
      });
    return () => controller.abort();
  }, [base, a, b, tab, retry, savedKey]);

  const run = async (action: () => Promise<void>) => {
    setPending(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (live.current) setError((e as Error).message);
    } finally {
      if (live.current) setPending(false);
    }
  };
  const setRemoteResult = async (result: Json) => {
    if (live.current) {
      setRemote(result);
      setPublication(null);
      setPublishedDiff(null);
    }
    await onChanged();
    await reload();
  };
  const compare = (left: string, right: string) => {
    pinned.current = null;
    setA(left);
    setB(right);
    setTab("compare");
    setRetry((v) => v + 1);
  };
  const openReview = (value: Json) => {
    setReview(value);
    setTab("review");
    setIntegrated(null);
  };
  const choices = (path: string, choice: string) => {
    if (!review) return;
    const sequence = ++reviewSequence.current;
    setPending(true);
    setError("");
    setReview({
      ...review,
      choices: { ...review.choices, [path]: choice },
      conflicts: review.conflicts.map((item: Json) =>
        item.path === path ? { ...item, choice } : item,
      ),
    });
    api<Json>(
      `/worktrees/${review.worktree}/git/reviews/${review.id}`,
      send({ choices: { ...review.choices, [path]: choice } }),
    )
      .then((value) => {
        if (live.current && sequence === reviewSequence.current)
          setReview(value);
      })
      .catch((e) => {
        if (live.current && sequence === reviewSequence.current) {
          setReview(review);
          setError(e.message);
        }
      })
      .finally(() => {
        if (live.current && sequence === reviewSequence.current)
          setPending(false);
      });
  };
  const historyFor = (id: string) => {
    setHistoryEntity(id);
    setTab("compare");
  };
  const heads = remote
    ? {
        config_revision: remote.config_revision,
        local_head: remote.local_head,
        remote_head: remote.remote_head,
      }
    : null;
  const localBranches = branches.filter((v) => !v.remote);
  const sourceBranch = branches.find((v) => v.ref === source);
  const destinationBranch = branches.find((v) => v.worktree === destination);
  const currentCommit = history.find((v) => v.commit === b);
  const syncReason = !canEdit
    ? t("gitReaderHint")
    : remote?.pending ||
      (!remote?.url
        ? t("configureOriginHint")
        : !remote?.remote_branch
          ? t("mappingRequired")
          : !remote?.checked
            ? t("fetchFirst")
            : "");
  const actionDisabled = pending || !!syncReason;

  return (
    <Modal title={t("gitWorkspace")} onClose={onClose} wide>
      <div className="git-workspace" ref={root}>
        <nav className="git-tabs" aria-label={t("gitWorkspace")}>
          {(["compare", "branches", "sync", "review"] as Mode[]).map(
            (value) => (
              <button
                key={value}
                className={tab === value ? "active" : ""}
                aria-pressed={tab === value}
                disabled={value === "review" && !review}
                onClick={() => setTab(value)}
              >
                {t(
                  {
                    compare: "compareVersions",
                    branches: "branches",
                    sync: "gitSynchronization",
                    review: "mergeReview",
                  }[value],
                )}
              </button>
            ),
          )}
        </nav>
        {error && (
          <div role="alert" className="notice error">
            {error}{" "}
            <button
              className="button secondary small"
              onClick={() =>
                tab === "compare" ? setRetry((v) => v + 1) : run(reload)
              }
            >
              {t("retry")}
            </button>
          </div>
        )}
        {pending && (
          <p role="status" className="muted">
            {t("working")}
          </p>
        )}
        <div className="git-content">
          {tab === "compare" && (
            <>
              <div className="git-revisions">
                {(["a", "b"] as const).map((side) => (
                  <label key={side}>
                    <strong>
                      {t(side === "a" ? "referenceA" : "targetB")}
                    </strong>
                    <input
                      aria-label={t(side === "a" ? "referenceA" : "targetB")}
                      list="git-revision-list"
                      value={side === "a" ? a : b}
                      onChange={(e) =>
                        side === "a"
                          ? setA(e.target.value)
                          : setB(e.target.value)
                      }
                    />
                    {report?.[side] && (
                      <small>
                        {report[side].name} ·{" "}
                        <code>{report[side].commit?.slice(0, 12) || "—"}</code>{" "}
                        · {report[side].author} ·{" "}
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
                  {history.map((v) => (
                    <option key={v.commit} value={v.commit}>
                      {v.message}
                    </option>
                  ))}
                </datalist>
                <button
                  className="button secondary"
                  onClick={() =>
                    compare(
                      pinned.current?.right || b,
                      pinned.current?.left || a,
                    )
                  }
                >
                  {t("swapAB")}
                </button>
                <button
                  className="button secondary"
                  onClick={() => compare(pinned.current?.left || a, "working")}
                >
                  {t("captureWorking")}
                </button>
              </div>
              {currentCommit && currentCommit.parents.length > 1 && (
                <label>
                  {t("actualParent")}{" "}
                  <Select value={a} onChange={(e) => setA(e.target.value)}>
                    {currentCommit.parents.map((parent: string) => (
                      <option key={parent} value={parent}>
                        {parent.slice(0, 12)}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <details className="git-history" open={!!historyEntity}>
                <summary>
                  {t("gitHistory")}
                  {historyEntity ? ` · ${historyEntity}` : ""}
                </summary>
                <label>
                  {t("elementHistory")}{" "}
                  <input
                    aria-label={t("historyEntity")}
                    list="git-entities"
                    value={historyEntity}
                    onChange={(e) => setHistoryEntity(e.target.value)}
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
                {history.map((item) => (
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
                        compare(item.parents[0] || "empty", item.commit)
                      }
                    >
                      {t("compareParent")}
                    </button>
                    <button
                      className="button secondary small"
                      onClick={() => setA(item.commit)}
                    >
                      A
                    </button>
                    <button
                      className="button secondary small"
                      onClick={() => setB(item.commit)}
                    >
                      B
                    </button>
                  </div>
                ))}
                {next !== null && (
                  <button
                    className="button secondary"
                    disabled={pending}
                    onClick={() =>
                      run(async () => {
                        const result = await api<Json>(
                          withQuery(`${base}/history`, {
                            ref: historyHead,
                            offset: next,
                            entity: historyEntity || undefined,
                          }),
                        );
                        if (live.current) {
                          setHistory((old) => [...old, ...result.items]);
                          setNext(result.next);
                        }
                      })
                    }
                  >
                    {t("loadMore")}
                  </button>
                )}
              </details>
              {comparing ? (
                <p role="status">{t("comparing")}</p>
              ) : (
                report &&
                !error && (
                  <ComparisonView
                    report={report}
                    storageKey={savedKey + ".filters"}
                    onHistory={historyFor}
                  />
                )
              )}
            </>
          )}
          {tab === "branches" && (
            <div className="git-branch-panel">
              {!canEdit && <p className="notice">{t("gitReaderHint")}</p>}
              <div className="git-controls">
                <label>
                  {t("sourceBranch")}{" "}
                  <Select
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                  >
                    {branches.map((v) => (
                      <option key={v.ref} value={v.ref}>
                        {v.name}
                        {v.remote ? ` (${t("remote")})` : ""}
                      </option>
                    ))}
                  </Select>
                </label>
                <span>→</span>
                <label>
                  {t("destinationBranch")}{" "}
                  <Select
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  >
                    {localBranches
                      .filter((v) => v.worktree)
                      .map((v) => (
                        <option key={v.ref} value={v.worktree}>
                          {v.name}
                        </option>
                      ))}
                  </Select>
                </label>
                <button
                  className="button secondary"
                  disabled={!sourceBranch || !destinationBranch}
                  onClick={() =>
                    compare(destinationBranch!.head, sourceBranch!.head)
                  }
                >
                  {t("compareVersions")}
                </button>
                <button
                  className="button primary"
                  disabled={
                    !canEdit ||
                    pending ||
                    !source ||
                    sourceBranch?.worktree === destination
                  }
                  onClick={() =>
                    run(async () =>
                      openReview(
                        await api<Json>(
                          `/worktrees/${destination}/git/reviews`,
                          send({ source }),
                        ),
                      ),
                    )
                  }
                >
                  {t("reviewMerge")}
                </button>
              </div>
              <p className="muted">{t("reviewMergeHint")}</p>
              {branches.map((item) => (
                <div className="git-commit" key={item.ref}>
                  <div>
                    <strong>
                      {item.name} {item.current ? `· ${t("current")}` : ""}
                    </strong>
                    <small>
                      {item.remote ? t("remoteBranch") : t("localBranch")} ·{" "}
                      {item.head.slice(0, 12)} · {t(item.state)}
                      {item.upstream &&
                        ` · origin/${item.upstream} · ${item.ahead ?? "—"} ↑ / ${item.behind ?? "—"} ↓`}
                    </small>
                  </div>
                  <button
                    className="button secondary small"
                    onClick={() => compare("HEAD", item.head)}
                  >
                    {t("compareVersions")}
                  </button>
                  {!item.remote && !item.current && (
                    <button
                      className="button secondary small"
                      disabled={pending || (!canEdit && !item.worktree)}
                      onClick={() =>
                        run(async () => {
                          const tree = item.worktree
                            ? { id: item.worktree }
                            : await api(
                                `${base}/open`,
                                send({ name: item.name }),
                              );
                          await onChanged();
                          onOpen(tree.id);
                          onClose();
                        })
                      }
                    >
                      {t("openBranch")}
                    </button>
                  )}
                </div>
              ))}
              <form
                className="git-controls"
                onSubmit={(e) => {
                  e.preventDefault();
                  run(async () => {
                    const tree = await api(
                      `/worktrees/${worktree}/branches`,
                      send({ name: branchName, revision }),
                    );
                    await onChanged();
                    onOpen(tree.id);
                    onClose();
                  });
                }}
              >
                <label>
                  {t("branchName")}{" "}
                  <input
                    required
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                  />
                </label>
                <label>
                  {t("startingRevision")}{" "}
                  <input
                    required
                    value={revision}
                    onChange={(e) => setRevision(e.target.value)}
                  />
                </label>
                <button
                  className="button primary"
                  disabled={!canEdit || pending}
                >
                  {t("newBranch")}
                </button>
              </form>
            </div>
          )}
          {tab === "sync" && remote && (
            <div className="git-sync-panel">
              <div className="git-sync-summary">
                <strong>
                  {remote.local_branch} → origin/{remote.remote_branch || "—"}
                </strong>
                <span className="badge">{t("sync_" + remote.state)}</span>
                <p>
                  {remote.ahead ?? "—"} {t("toPush")} / {remote.behind ?? "—"}{" "}
                  {t("toIntegrate")}
                </p>
                <small>
                  {t("lastCheck")}:{" "}
                  {remote.checked
                    ? new Date(remote.checked).toLocaleString()
                    : t("neverChecked")}
                </small>
                <p>
                  {t("localHead")}: <code>{remote.local_head}</code>
                  <br />
                  {t("remoteHead")}: <code>{remote.remote_head || "—"}</code>
                </p>
              </div>
              <details open={!remote.url}>
                <summary>{t("remoteConfiguration")}</summary>
                <p>{t("serverGitAuthentication")}</p>
                <form
                  className="git-controls"
                  onSubmit={(e) => {
                    e.preventDefault();
                    run(async () =>
                      setRemoteResult(
                        await api<Json>(
                          `${base}/remote`,
                          send(
                            {
                              url,
                              remote_branch: mapping,
                              config_revision: remote.config_revision,
                            },
                            "PUT",
                          ),
                        ),
                      ),
                    );
                  }}
                >
                  <label>
                    {t("repositoryUrl")}{" "}
                    <input
                      required
                      placeholder="https://example.com/team/project.git"
                      disabled={role !== "admin"}
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                  </label>
                  <label>
                    {t("remoteBranch")}{" "}
                    <input
                      required
                      disabled={role !== "admin"}
                      value={mapping}
                      onChange={(e) => setMapping(e.target.value)}
                    />
                  </label>
                  <button
                    className="button primary"
                    disabled={pending || role !== "admin"}
                  >
                    {t("saveConfiguration")}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={pending || role !== "admin" || !remote.url}
                    onClick={() =>
                      run(async () =>
                        setRemoteResult(
                          await api<Json>(
                            `${base}/remote`,
                            send(
                              {
                                url: null,
                                config_revision: remote.config_revision,
                              },
                              "PUT",
                            ),
                          ),
                        ),
                      )
                    }
                  >
                    {t("disconnectRemote")}
                  </button>
                </form>
                {role !== "admin" && (
                  <p className="notice">{t("remoteAdminHint")}</p>
                )}
              </details>
              {syncReason && <p className="notice">{syncReason}</p>}
              <div className="git-controls">
                <button
                  className="button secondary"
                  disabled={pending}
                  onClick={() => run(reload)}
                >
                  {t("reloadState")}
                </button>
                <button
                  className="button primary"
                  disabled={pending || !canEdit || !remote.url}
                  onClick={() =>
                    run(async () =>
                      setRemoteResult(
                        await api<Json>(
                          `${base}/fetch`,
                          send({ config_revision: remote.config_revision }),
                        ),
                      ),
                    )
                  }
                >
                  {t("fetchRemote")}
                </button>
                <button
                  className="button secondary"
                  disabled={
                    actionDisabled ||
                    !remote.remote_head ||
                    remote.state === "unrelated"
                  }
                  onClick={() =>
                    run(async () =>
                      openReview(await api<Json>(`${base}/pull`, send(heads))),
                    )
                  }
                >
                  {t("reviewPull")}
                </button>
                <button
                  className="button secondary"
                  disabled={
                    actionDisabled ||
                    ["behind", "diverged", "unrelated", "unverified"].includes(
                      remote.state,
                    )
                  }
                  onClick={() =>
                    run(async () => {
                      const value = await api<Json>(
                        withQuery(`${base}/compare`, {
                          a: remote.remote_head || "empty",
                          b: remote.local_head,
                        }),
                      );
                      if (live.current) {
                        setPublication(remote);
                        setPublishedDiff(value);
                        setRecreate(false);
                      }
                    })
                  }
                >
                  {t("reviewPush")}
                </button>
              </div>
              <p className="muted">{t("fetchPullHint")}</p>
              {[
                "behind",
                "diverged",
                "unrelated",
                "unverified",
                "remote_deleted",
              ].includes(remote.state) && (
                <p className="notice">{t("recovery_" + remote.state)}</p>
              )}
              {publication && publishedDiff && (
                <section className="publication-review">
                  <h3>
                    {t("publishReviewedHead")}:{" "}
                    {publication.local_head.slice(0, 12)} → origin/
                    {publication.remote_branch}
                  </h3>
                  <ComparisonView
                    report={publishedDiff}
                    storageKey={savedKey + ".publishFilters"}
                  />
                  {publication.state === "remote_deleted" && (
                    <label>
                      <input
                        type="checkbox"
                        checked={recreate}
                        onChange={(e) => setRecreate(e.target.checked)}
                      />{" "}
                      {t("recreateRemoteBranch")}
                    </label>
                  )}
                  <button
                    className="button primary"
                    disabled={
                      pending ||
                      (publication.state === "remote_deleted" && !recreate)
                    }
                    onClick={() =>
                      run(async () =>
                        setRemoteResult(
                          await api<Json>(
                            `${base}/push`,
                            send({
                              config_revision: publication.config_revision,
                              local_head: publication.local_head,
                              remote_head: publication.remote_head,
                              recreate,
                            }),
                          ),
                        ),
                      )
                    }
                  >
                    {t("publishReviewedHead")}
                  </button>
                </section>
              )}
            </div>
          )}
          {tab === "review" && review && (
            <div className="git-review-panel">
              <h3>
                {review.source} → {review.destination}
              </h3>
              <p>
                {t("commonBase")}: <code>{review.base_head.slice(0, 12)}</code>{" "}
                · {t("incoming")}:{" "}
                <code>{review.source_head.slice(0, 12)}</code> · {t("current")}:{" "}
                <code>{review.target_head.slice(0, 12)}</code>
              </p>
              <p className="muted">{t("reviewMergeHint")}</p>
              {review.conflicts.length > 0 && (
                <section>
                  <h3>
                    {t("fieldConflicts")} · {review.unresolved.length}{" "}
                    {t("unresolved")}
                  </h3>
                  {review.conflicts.map((conflict: Json) => (
                    <fieldset className="git-conflict" key={conflict.path}>
                      <legend>{conflict.path}</legend>
                      <div className="git-conflict-values">
                        {["base", "current", "incoming"].map((choice) => (
                          <label key={choice}>
                            <span>
                              <input
                                type="radio"
                                name={conflict.path}
                                checked={conflict.choice === choice}
                                disabled={pending || !!integrated}
                                onChange={() => choices(conflict.path, choice)}
                              />{" "}
                              {t(choice)}
                            </span>
                            <pre>
                              {conflict[choice].present
                                ? typeof conflict[choice].value === "string"
                                  ? conflict[choice].value
                                  : JSON.stringify(
                                      conflict[choice].value,
                                      null,
                                      2,
                                    )
                                : t("absent")}
                            </pre>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ))}
                </section>
              )}
              {review.diagnostics.map((d: Json, i: number) => (
                <p key={i} className="notice error">
                  {d.file}: {d.message}
                </p>
              ))}
              <ComparisonView
                report={review.comparison}
                storageKey={savedKey + ".reviewFilters"}
              />
              {!integrated ? (
                <div className="git-controls">
                  <button
                    className="button secondary"
                    onClick={() => {
                      setReview(null);
                      setTab("branches");
                    }}
                  >
                    {t("cancel")}
                  </button>
                  <button
                    className="button primary"
                    disabled={
                      pending ||
                      !canEdit ||
                      review.unresolved.length > 0 ||
                      review.diagnostics.length > 0
                    }
                    onClick={() =>
                      run(async () => {
                        await api(
                          `/worktrees/${review.worktree}/git/reviews/${review.id}/apply`,
                          send({
                            choices: review.choices,
                            proposal_revision: review.proposal_revision,
                          }),
                        );
                        if (live.current) setIntegrated(review);
                        await onChanged();
                        await reload();
                      })
                    }
                  >
                    {t("applyReviewedMerge")}
                  </button>
                  <span className="muted">
                    {review.unresolved.length > 0
                      ? t("resolveBeforeApply")
                      : review.diagnostics.length > 0
                        ? t("fixBeforeApply")
                        : t("noImplicitExecution")}
                  </span>
                </div>
              ) : (
                <div className="notice">
                  <p>{t("mergeComplete")}</p>
                  {integrated.source_worktree &&
                    integrated.source_worktree !== worktree &&
                    integrated.source !== "main" && (
                      <button
                        className="button secondary"
                        disabled={pending}
                        onClick={() =>
                          run(async () => {
                            await api(
                              `${base}/cleanup`,
                              send({
                                remove_worktree: integrated.source_worktree,
                                integrated_worktree: integrated.worktree,
                                expected_head: integrated.source_head,
                              }),
                            );
                            setIntegrated({
                              ...integrated,
                              source_worktree: null,
                            });
                            await onChanged();
                            await reload();
                          })
                        }
                      >
                        {t("removeIntegratedBranch")} {integrated.source}
                      </button>
                    )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
