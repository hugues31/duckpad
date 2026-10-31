import { DEBUG_ASSISTANT_EVENT, type DebugRequest } from "./AskAssistant";
import {
  AssistantLauncher,
  chatPlacement,
  useLauncherPosition,
} from "./AssistantLauncher";
import { useDefaultPrompts } from "./AssistantPrompts";
import { AssistantRun, type RunControls } from "./AssistantRun";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleX,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Undo2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useNavigate } from "react-router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAssistantError } from "./assistantErrors";
import { api, send, streamAssistant } from "./api";
import type {
  AssistantContext,
  AssistantAction,
  AssistantEvent,
  AssistantTool,
  AssistantTurn,
  Conversation,
} from "./assistantTypes";
import { useT, type TranslationKey } from "./i18n";
import { trapFocus } from "./modals";
import { usePageRoute, worktreeUrl } from "./navigation";
import { useShell } from "./shell";
import type { Graph } from "./types";
import { useWorktree } from "./worktree";

const toolLabels: Record<string, TranslationKey> = {
  read_flow: "assistantReadFlow",
  read_file: "assistantReadFile",
  read_sql: "assistantReadSql",
  read_documentation: "assistantReadDocs",
  read_schemas: "assistantReadSchemas",
  read_runs: "assistantReadRuns",
  search_project: "assistantSearch",
  read_history: "assistantReadHistory",
  preview_output: "assistantPreview",
  explain_value: "assistantLineage",
  edit_flow: "assistantEditFlow",
  write_sql: "assistantWriteSql",
  write_documentation: "assistantWriteDocs",
  edit_variable: "assistantEditVariable",
  group_nodes: "assistantGroupNodes",
  launch_run: "assistantLaunchRun",
  cancel_run: "assistantCancelRun",
  wait_for_run: "assistantWaitRun",
  inspect_run: "assistantInspectRun",
  read_run_sql: "assistantRunSql",
  compare_run: "assistantCompareRun",
};

const statusIcons: Partial<Record<TranslationKey, LucideIcon>> = {
  assistantRunConfirmation: CirclePause,
  assistantRunApproved: CircleCheck,
  assistantRunDeclined: CircleX,
  assistantReading: LoaderCircle,
  assistantComplete: CircleCheck,
  assistantStopped: CircleX,
};
// Within this distance of the end, the log follows new content.
const FOLLOW_DISTANCE = 48;

interface ActionControls extends RunControls {
  canUndo?: boolean;
  onUndo?: (action?: string) => void;
  onCompare?: (action: AssistantAction) => void;
  onConflict?: (conflict: string) => void;
}

function ToolCard({
  tool,
  canUndo,
  onUndo,
  onCompare,
  onConflict,
  canApprove,
  canCancel,
  onDecision,
}: { tool: AssistantTool } & ActionControls) {
  const t = useT();
  const action = tool.action;
  const target =
    tool.args.node ||
    tool.args.path ||
    tool.args.template ||
    tool.args.section ||
    "";
  const status =
    tool.approval?.decision === null
      ? "assistantRunConfirmation"
      : tool.status === "approved"
        ? "assistantRunApproved"
        : tool.status === "denied"
          ? "assistantRunDeclined"
          : tool.status === "running"
            ? "assistantReading"
            : tool.status === "complete"
              ? "assistantComplete"
              : tool.status === "stopped"
                ? "assistantStopped"
                : "assistantFailed";
  const Icon = statusIcons[status] || CircleAlert;
  return (
    <div className="assistant-tool">
      <details open={action || tool.approval ? true : undefined}>
        <summary>
          <span className="assistant-tool-icon" data-status={status}>
            <Icon
              size={14}
              className={status === "assistantReading" ? "spin" : undefined}
            />
          </span>
          <span className="assistant-tool-label">
            {t(toolLabels[tool.name] || "assistantReadFlow")}
            {target ? ` · ${String(target)}` : ""}
          </span>
          <small>
            {t(
              action?.status === "undone"
                ? "assistantUndone"
                : action?.status === "discarded"
                  ? "assistantDiscarded"
                  : status,
            )}
          </small>
          <ChevronRight size={14} className="assistant-tool-chevron" />
        </summary>
        {tool.approval ? (
          <AssistantRun
            tool={tool}
            canApprove={canApprove}
            canCancel={canCancel}
            onDecision={onDecision}
          />
        ) : action ? (
          <>
            <ul className="assistant-changes">
              {action.changes.map((change) => (
                <li key={change.id}>
                  {t(change.status)} · {change.name}
                </li>
              ))}
            </ul>
            {action.change_count > action.changes.length && (
              <p className="muted">{t("assistantMoreChanges")}</p>
            )}
            {action.affected_nodes !== undefined && (
              <p>
                {t("assistantAffectedNodes").replace(
                  "{count}",
                  String(action.affected_nodes),
                )}
              </p>
            )}
            {action.sql_diffs.map((diff) => (
              <div key={diff.path}>
                <code>{diff.path}</code>
                <pre>{diff.diff}</pre>
                {diff.truncated && <small>{t("assistantMoreChanges")}</small>}
              </div>
            ))}
          </>
        ) : (
          <pre>{tool.summary || t(status)}</pre>
        )}
      </details>
      {action && (
        <div className="assistant-action-buttons">
          {action.commit && (
            <button
              className="button secondary small"
              onClick={() => onCompare?.(action)}
              disabled={!onCompare}
            >
              {t("compareVersions")}
            </button>
          )}
          {action.commit && action.status !== "undone" && (
            <button
              className="button secondary small"
              disabled={!canUndo || !!action.conflict}
              onClick={() => onUndo?.(action.id)}
            >
              <Undo2 size={14} />
              {t("assistantUndo")}
            </button>
          )}
          {action.conflict && (
            <button
              className="button secondary small"
              disabled={!onConflict}
              onClick={() => onConflict?.(action.conflict!)}
            >
              {t("assistantResolveConflict")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The answer is on its way: a morphing gradient orb and a shimmering label. */
function AssistantThinking() {
  const t = useT();
  return (
    <p className="assistant-thinking" role="status">
      <span className="assistant-orb" aria-hidden="true" />
      <span className="assistant-shimmer">{t("assistantThinking")}</span>
    </p>
  );
}

export function AssistantMessage({
  turn,
  thinking = false,
  entering = false,
  ...controls
}: {
  turn: AssistantTurn;
  thinking?: boolean;
  entering?: boolean;
} & ActionControls) {
  const t = useT();
  const explainError = useAssistantError();
  const remaining = turn.tools.filter(
    (tool) => tool.action?.commit && tool.action.status === "applied",
  ).length;
  return (
    <article className={`assistant-turn${entering ? " entering" : ""}`}>
      <p className="assistant-question">{turn.user}</p>
      <div className="assistant-answer">
        {turn.tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} {...controls} />
        ))}
        {remaining > 1 && (
          <button
            className="button secondary small"
            disabled={!controls.canUndo}
            onClick={() => controls.onUndo?.()}
          >
            <Undo2 size={14} />
            {t("assistantUndoTurn").replace("{count}", String(remaining))}
          </button>
        )}
        {turn.text && (
          <div className="assistant-markdown">
            <Markdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              urlTransform={(url) => (/^(https?:\/\/|#)/i.test(url) ? url : "")}
              components={{
                img: () => null,
                a: ({ children, href }) => (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {turn.text}
            </Markdown>
          </div>
        )}
        {turn.error && (
          <p className="notice error" role="alert">
            {explainError(turn.error)}
          </p>
        )}
        {turn.status === "stopped" && (
          <p className="muted">{t("assistantStopped")}</p>
        )}
        {thinking && <AssistantThinking />}
      </div>
    </article>
  );
}

export default function AssistantChat() {
  const t = useT();
  const explainError = useAssistantError();
  const { workspace, environment, drafts, openModal } = useShell();
  const worktree = useWorktree();
  const route = usePageRoute();
  const navigate = useNavigate();
  const options = workspace?.assistant;
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<AssistantTurn | null>(null);
  // The turn that streams again after a run approval.
  const [continuing, setContinuing] = useState("");
  const [answers, setAnswers] = useState(0);
  const [seenAnswers, setSeenAnswers] = useState(0);
  const [atEnd, setAtEnd] = useState(true);
  const launcherPosition = useLauncherPosition();
  const [debug, setDebug] = useState<
    (DebugRequest & { worktree: string }) | null
  >(null);
  const defaultPrompts = useDefaultPrompts();
  // Whether the log follows new content, and where the reader left it.
  const following = useRef(true);
  const readingAt = useRef(0);
  const awaitingApproval =
    conversation?.turns.at(-1)?.status === "awaiting_approval";
  useEffect(() => {
    const receive = (event: Event) => {
      if (busy || undoing) return;
      const detail = (event as CustomEvent<DebugRequest>).detail;
      setDebug({ ...detail, worktree: worktree.id });
      setConversation(null);
      setPending(null);
      setDraft(detail.prompt);
      following.current = true;
      setOpen(true);
    };
    window.addEventListener(DEBUG_ASSISTANT_EVENT, receive);
    return () => window.removeEventListener(DEBUG_ASSISTANT_EVENT, receive);
  }, [busy, undoing, worktree.id]);
  const controller = useRef<AbortController | null>(null);
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const identity = useRef("");
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!options?.enabled) controller.current?.abort();
  }, [options?.enabled]);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  // Reopening the chat returns to where the reader left the conversation.
  useLayoutEffect(() => {
    const element = log.current;
    if (!open || !element) return;
    element.scrollTop = following.current
      ? element.scrollHeight
      : readingAt.current;
  }, [open]);
  useLayoutEffect(() => {
    const element = log.current;
    if (element && following.current) element.scrollTop = element.scrollHeight;
  }, [pending, conversation, busy, error, maximized]);
  const followLog = () => {
    const element = log.current;
    if (!element) return;
    following.current =
      element.scrollHeight - element.scrollTop - element.clientHeight <
      FOLLOW_DISTANCE;
    readingAt.current = element.scrollTop;
    setAtEnd(following.current);
  };
  const showLatest = () => {
    following.current = true;
    log.current?.scrollTo({
      top: log.current.scrollHeight,
      behavior: "smooth",
    });
  };
  const context: AssistantContext = {
    page: route.area,
    ...(route.tab ? { tab: route.tab } : {}),
    section: route.section || "",
    project: worktree.snapshot?.worktree.project || route.projectId || null,
    worktree: worktree.id,
    branch: worktree.snapshot?.worktree.branch || "",
    node: route.tab === "flow" ? worktree.assistantNode : "",
    file: route.tab === "code" ? worktree.assistantFile : "",
    environment,
    ...(debug?.worktree === worktree.id
      ? {
          run: debug.run,
          node: debug.node || "",
          environment: debug.environment,
        }
      : {}),
  };
  let nodeLabel = context.node;
  let graph: Graph | undefined = worktree.snapshot?.bundle?.flow;
  for (const part of context.node.split("::")) {
    const node = graph?.nodes.find((item) => item.id === part);
    if (!node) break;
    nodeLabel = node.label || part;
    graph = node.component
      ? worktree.snapshot?.bundle?.components[node.component]
      : undefined;
  }
  const choices = options?.models || [];
  const selected =
    choices.find((m) => JSON.stringify([m.provider, m.model]) === model) ||
    choices.find(
      (m) =>
        m.provider === options?.default_provider &&
        m.model === options?.default_model,
    ) ||
    choices[0];
  const selectedKey = selected
    ? JSON.stringify([selected.provider, selected.model])
    : "";
  const bound =
    !conversation ||
    (conversation.worktree === context.worktree &&
      conversation.project === context.project &&
      conversation.branch === context.branch);
  // Conflict resolutions happen in the existing workspace dialog.
  useEffect(() => {
    if (!conversation?.id || busy || undoing) return;
    let cancelled = false;
    void api<Conversation>(`/assistant/conversations/${conversation.id}`)
      .then((value) => {
        if (!cancelled) setConversation(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    conversation?.id,
    busy,
    undoing,
    worktree.snapshot?.revision,
    worktree.snapshot?.conflicts,
  ]);

  async function list(offset = 0) {
    const result = await api<{
      items: Conversation[];
      next_offset: number | null;
    }>(`/assistant/conversations?offset=${offset}`);
    setConversations((current) =>
      offset ? [...current, ...result.items] : result.items,
    );
    setNextOffset(result.next_offset);
  }
  async function resume(item: Conversation) {
    try {
      const value = await api<Conversation>(
        `/assistant/conversations/${item.id}`,
      );
      following.current = true;
      setConversation(value);
      setDebug(null);
      setTitle(value.title);
      setPending(null);
      setError("");
      if (value.worktree)
        void navigate(worktreeUrl(value.worktree, "flow", environment));
      else if (value.project)
        void navigate(`/projects/${value.project}/settings`);
      else void navigate("/projects");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function submit(message = draft) {
    if (busy || undoing || awaitingApproval || !message.trim() || !selected)
      return;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    let value = conversation;
    let current: AssistantTurn = {
      user: message.trim(),
      text: "",
      tools: [],
      context,
      provider: selected.provider,
      model: selected.model,
      status: "running",
      error: "",
    };
    try {
      if (worktree.id) {
        await drafts.persist();
        await worktree.flush();
      }
      if (!value || !bound) {
        value = await api<Conversation>("/assistant/conversations", {
          ...send(context),
          signal: abort.signal,
        });
        setConversation(value);
      }
      identity.current = value.id;
      following.current = true;
      setPending(current);
      setDraft("");
      const receive = (event: AssistantEvent) => {
        if (event.type === "text")
          current = { ...current, text: current.text + event.text };
        else if (event.type === "tool")
          current = {
            ...current,
            tools: [
              ...current.tools.filter((tool) => tool.id !== event.tool.id),
              event.tool,
            ],
          };
        else if (event.type === "done") current = event.turn;
        if (
          (event.type === "tool" && event.tool.action) ||
          event.type === "done"
        )
          void worktree.refresh();
        setPending(current);
      };
      await streamAssistant(
        `/assistant/conversations/${value.id}/messages`,
        {
          message: current.user,
          provider: selected.provider,
          model: selected.model,
          context,
        },
        receive,
        abort.signal,
      );
      const updated = await api<Conversation>(
        `/assistant/conversations/${value.id}`,
      );
      setConversation(updated);
      setTitle(updated.title);
      setPending(null);
      setAnswers((count) => count + 1);
      if (maximized) void list().catch((e: Error) => setError(e.message));
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      controller.current = null;
      identity.current = "";
      setBusy(false);
    }
  }
  async function handleDecision(
    turn: AssistantTurn,
    tool: string,
    approved: boolean,
  ) {
    if (!conversation || !turn.id || busy || undoing || !bound) return;
    setBusy(true);
    setContinuing(turn.id);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    identity.current = conversation.id;
    let current = { ...turn };
    try {
      if (approved) {
        await drafts.persist();
        await worktree.flush();
      }
      await streamAssistant(
        `/assistant/conversations/${conversation.id}/approvals`,
        { turn: turn.id, tool, approved },
        (event) => {
          if (event.type === "text")
            current = { ...current, text: current.text + event.text };
          else if (event.type === "tool")
            current = {
              ...current,
              tools: [
                ...current.tools.filter((t) => t.id !== event.tool.id),
                event.tool,
              ],
            };
          else if (event.type === "done") current = event.turn;
          setConversation(
            (value) =>
              value && {
                ...value,
                turns: value.turns.map((t) => (t.id === turn.id ? current : t)),
              },
          );
        },
        abort.signal,
      );
      setConversation(
        await api<Conversation>(`/assistant/conversations/${conversation.id}`),
      );
      setAnswers((count) => count + 1);
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      controller.current = null;
      identity.current = "";
      setContinuing("");
      setBusy(false);
      void worktree.refresh();
    }
  }
  async function undo(turn: AssistantTurn, action = "") {
    if (!conversation || !turn.id || busy || undoing || !bound) return;
    setUndoing(true);
    setError("");
    try {
      await drafts.persist();
      await worktree.flush();
      const value = await api<Conversation>(
        `/assistant/conversations/${conversation.id}/undo`,
        send({
          turn: turn.id,
          action,
          context: { ...context, node: "", file: "" },
        }),
      );
      setConversation(value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await worktree.refresh();
      setUndoing(false);
    }
  }
  const actionControls = (turn: AssistantTurn): ActionControls => ({
    canCancel: bound && worktree.canEdit,
    canApprove: !busy && !undoing && bound && worktree.canEdit,
    canUndo: !busy && !undoing && bound && worktree.canEdit,
    onUndo: (action) => void undo(turn, action),
    onCompare: bound
      ? (action) =>
          openModal({
            kind: "git",
            worktree: context.worktree,
            commit: action.commit,
          })
      : undefined,
    onConflict:
      bound && !busy && !undoing
        ? (conflict) =>
            openModal({
              kind: "conflict",
              worktree: context.worktree,
              conflict,
            })
        : undefined,
  });
  async function stop() {
    if (!identity.current) return;
    try {
      await api(`/assistant/conversations/${identity.current}/stop`, send({}));
    } catch (e) {
      controller.current?.abort();
      setError((e as Error).message);
    }
  }
  const close = () => {
    setOpen(false);
    setSeenAnswers(answers);
    launcher.current?.focus();
  };
  if (!options?.enabled) return null;
  return (
    <>
      <AssistantLauncher
        ref={launcher}
        open={open}
        busy={busy && !open}
        unread={answers > seenAnswers}
        position={launcherPosition.position}
        viewport={launcherPosition.viewport}
        onMove={launcherPosition.move}
        onToggle={() => (open ? close() : setOpen(true))}
      />
      {open && (
        <section
          className={`assistant-chat${maximized ? " maximized" : ""}`}
          style={
            maximized
              ? undefined
              : chatPlacement(
                  launcherPosition.position,
                  launcherPosition.viewport.height,
                )
          }
          role="dialog"
          aria-modal={maximized}
          aria-label={t("assistant")}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            } else if (maximized) trapFocus(event, event.currentTarget);
          }}
        >
          <header className="assistant-header">
            <span className="assistant-avatar" aria-hidden="true">
              <Sparkles size={17} />
            </span>
            <div className="assistant-heading">
              <strong>{t("assistant")}</strong>
              <p className="assistant-context" title={t("assistantContext")}>
                {t(
                  route.tab || route.area === "pipelines"
                    ? route.tab || "flow"
                    : route.area === "notFound"
                      ? "routeNotFound"
                      : route.area === "home"
                        ? "projects"
                        : route.area,
                )}
                {context.node && <> · {nodeLabel}</>}
                {context.file && <> · {context.file}</>}
                {context.worktree && context.environment !== environment && (
                  <> · {context.environment}</>
                )}
              </p>
            </div>
            <div className="assistant-header-actions">
              <button
                title={t("assistantNew")}
                aria-label={t("assistantNew")}
                disabled={busy || undoing}
                onClick={() => {
                  following.current = true;
                  setConversation(null);
                  setDebug(null);
                  setPending(null);
                  setTitle("");
                  setError("");
                  input.current?.focus();
                }}
              >
                <Plus size={17} />
              </button>
              <button
                title={t(maximized ? "assistantMinimize" : "assistantMaximize")}
                aria-label={t(
                  maximized ? "assistantMinimize" : "assistantMaximize",
                )}
                onClick={() => {
                  setMaximized(!maximized);
                  if (!maximized)
                    void list().catch((e: Error) => setError(e.message));
                }}
              >
                {maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
              </button>
              <button
                title={t("close")}
                aria-label={t("close")}
                onClick={close}
              >
                <X size={18} />
              </button>
            </div>
          </header>
          <div className="assistant-body">
            {maximized && (
              <aside
                className="assistant-history"
                aria-label={t("assistantConversations")}
              >
                <h3>{t("assistantConversations")}</h3>
                {conversations.length === 0 && (
                  <p className="muted">{t("assistantNoConversations")}</p>
                )}
                {conversations.map((item) => (
                  <button
                    key={item.id}
                    disabled={busy || undoing}
                    className={item.id === conversation?.id ? "active" : ""}
                    onClick={() => void resume(item)}
                  >
                    <strong>{item.title}</strong>
                    <small>{item.branch}</small>
                  </button>
                ))}
                {nextOffset !== null && (
                  <button
                    onClick={() =>
                      void list(nextOffset).catch((e: Error) =>
                        setError(e.message),
                      )
                    }
                  >
                    {t("assistantMore")}
                  </button>
                )}
              </aside>
            )}
            <div className="assistant-main">
              {maximized && conversation && (
                <form
                  className="assistant-title"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void api<Conversation>(
                      `/assistant/conversations/${conversation.id}`,
                      send({ title }, "PATCH"),
                    )
                      .then((v) => {
                        setConversation(v);
                        return list();
                      })
                      .catch((e: Error) => setError(e.message));
                  }}
                >
                  <input
                    aria-label={t("assistantTitle")}
                    value={title}
                    maxLength={120}
                    required
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <button
                    className="button secondary small"
                    disabled={busy || undoing}
                  >
                    {t("save")}
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={t("assistantDelete")}
                    title={t("assistantDelete")}
                    disabled={busy || undoing}
                    onClick={() =>
                      void api(`/assistant/conversations/${conversation.id}`, {
                        method: "DELETE",
                      })
                        .then(() => {
                          setConversation(null);
                          setPending(null);
                          return list();
                        })
                        .catch((e: Error) => setError(e.message))
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </form>
              )}
              {!bound && (
                <p className="assistant-notice">
                  {t("assistantDifferentBranch")}
                </p>
              )}
              {context.worktree && worktree.snapshot && !worktree.canEdit && (
                <p className="assistant-notice">{t("assistantReadOnly")}</p>
              )}
              <div className="assistant-log">
                <div
                  ref={log}
                  className="assistant-messages"
                  role="log"
                  aria-label={t("assistantMessages")}
                  aria-live="polite"
                  aria-relevant="additions"
                  onScroll={followLog}
                >
                  {!conversation?.turns.length && !pending && (
                    <div className="assistant-welcome">
                      <span
                        className="assistant-welcome-mark"
                        aria-hidden="true"
                      >
                        <Sparkles size={24} />
                      </span>
                      <h3>{t("assistantWelcome")}</h3>
                      <p>{t("assistantWelcomeHint")}</p>
                      <div className="assistant-quick-prompts">
                        {(options.quick_prompts ?? defaultPrompts).map(
                          (prompt, index) => (
                            <button
                              key={index}
                              type="button"
                              className="assistant-chip"
                              disabled={busy || undoing || !selected}
                              onClick={() => void submit(prompt.prompt)}
                            >
                              {prompt.label}
                            </button>
                          ),
                        )}
                      </div>
                      <small>
                        {t(
                          options.allow_data
                            ? "assistantDataOn"
                            : "assistantDataOff",
                        )}
                      </small>
                    </div>
                  )}
                  {conversation?.turns.map((turn, index) => (
                    <AssistantMessage
                      key={turn.id || index}
                      turn={turn}
                      thinking={busy && !!turn.id && turn.id === continuing}
                      {...actionControls(turn)}
                      onDecision={
                        !busy &&
                        !undoing &&
                        bound &&
                        turn.status === "awaiting_approval"
                          ? (tool, approved) =>
                              void handleDecision(turn, tool, approved)
                          : undefined
                      }
                    />
                  ))}
                  {pending && (
                    <AssistantMessage
                      turn={pending}
                      thinking={busy}
                      entering
                      {...actionControls(pending)}
                    />
                  )}
                  {busy && !pending && !continuing && <AssistantThinking />}
                </div>
                {!atEnd && (
                  <button
                    type="button"
                    className="assistant-latest"
                    title={t("assistantLatest")}
                    aria-label={t("assistantLatest")}
                    onClick={showLatest}
                  >
                    <ArrowDown size={16} />
                  </button>
                )}
              </div>
              {error && (
                <p className="notice error" role="alert">
                  {explainError(error)}
                </p>
              )}
              {awaitingApproval && (
                <p className="assistant-notice">
                  {t("assistantAnswerConfirmation")}
                </p>
              )}
              <form
                className="assistant-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <div className={`assistant-input${busy ? " busy" : ""}`}>
                  <textarea
                    id="assistant-prompt"
                    ref={input}
                    rows={2}
                    maxLength={16000}
                    value={draft}
                    disabled={undoing}
                    aria-label={t("assistantMessage")}
                    placeholder={t("assistantMessageHint")}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        void submit();
                      }
                    }}
                  />
                  <footer>
                    <select
                      aria-label={t("assistantModel")}
                      disabled={busy || undoing}
                      value={selectedKey}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      {choices.map((m) => (
                        <option
                          key={`${m.provider}/${m.model}`}
                          value={JSON.stringify([m.provider, m.model])}
                        >
                          {m.kind} · {m.model}
                        </option>
                      ))}
                    </select>
                    {busy ? (
                      <button
                        className="assistant-send stop"
                        type="button"
                        title={t("assistantStop")}
                        aria-label={t("assistantStop")}
                        onClick={() => void stop()}
                      >
                        <Square size={12} fill="currentColor" />
                      </button>
                    ) : (
                      <button
                        className="assistant-send"
                        title={t("assistantSend")}
                        aria-label={t("assistantSend")}
                        disabled={
                          awaitingApproval ||
                          !draft.trim() ||
                          !selected ||
                          undoing ||
                          (!!worktree.id && !worktree.snapshot)
                        }
                      >
                        <ArrowUp size={17} />
                      </button>
                    )}
                  </footer>
                </div>
              </form>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
