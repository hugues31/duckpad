import { useEffect, useRef, useState } from "react";
import {
  Maximize2,
  MessageSquare,
  Minimize2,
  Plus,
  Send,
  Square,
  Trash2,
  Undo2,
  X,
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
};

interface ActionControls {
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
    tool.status === "running"
      ? "assistantReading"
      : tool.status === "complete"
        ? "assistantComplete"
        : tool.status === "stopped"
          ? "assistantStopped"
          : "assistantFailed";
  return (
    <div className="assistant-tool">
      <details open={action ? true : undefined}>
        <summary>
          <span>
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
        </summary>
        {action ? (
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

export function AssistantMessage({
  turn,
  ...controls
}: { turn: AssistantTurn } & ActionControls) {
  const t = useT();
  const explainError = useAssistantError();
  const remaining = turn.tools.filter(
    (tool) => tool.action?.commit && tool.action.status === "applied",
  ).length;
  return (
    <article className="assistant-turn">
      <p className="assistant-question">{turn.user}</p>
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
      {turn.error && (
        <p className="notice error" role="alert">
          {explainError(turn.error)}
        </p>
      )}
      {turn.status === "stopped" && (
        <p className="muted">{t("assistantStopped")}</p>
      )}
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
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [pending, conversation]);
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
      setConversation(value);
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
  async function submit() {
    if (busy || undoing || !draft.trim() || !selected) return;
    setBusy(true);
    setError("");
    const abort = new AbortController();
    controller.current = abort;
    let value = conversation;
    let current: AssistantTurn = {
      user: draft.trim(),
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
      if (maximized) await list();
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message);
    } finally {
      controller.current = null;
      identity.current = "";
      setBusy(false);
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
    launcher.current?.focus();
  };
  if (!options?.enabled) return null;
  return (
    <>
      <button
        ref={launcher}
        className="assistant-launcher button primary"
        aria-label={t("assistantOpen")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MessageSquare size={20} />
        <span>{t("assistant")}</span>
      </button>
      {open && (
        <section
          className={`assistant-chat${maximized ? " maximized" : ""}`}
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
            <strong>{t("assistant")}</strong>
            <div className="row gap">
              <button
                className="icon-button"
                title={t("assistantNew")}
                aria-label={t("assistantNew")}
                disabled={busy || undoing}
                onClick={() => {
                  setConversation(null);
                  setPending(null);
                  setTitle("");
                  setError("");
                  input.current?.focus();
                }}
              >
                <Plus size={17} />
              </button>
              <button
                className="icon-button"
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
                {maximized ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
              </button>
              <button
                className="icon-button"
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
              <p className="assistant-context" title={t("assistantContext")}>
                <span>
                  {t(
                    route.tab || route.area === "pipelines"
                      ? route.tab || "flow"
                      : route.area === "notFound"
                        ? "routeNotFound"
                        : route.area === "home"
                          ? "projects"
                          : route.area,
                  )}
                </span>
                {context.branch && <> · {context.branch}</>}
                {context.node && <> · {nodeLabel}</>}
                {context.file && <> · {context.file}</>}
                {context.worktree && <> · {context.environment}</>}
              </p>
              {!bound && (
                <p className="assistant-context">
                  {t("assistantDifferentBranch")}
                </p>
              )}
              {context.worktree && worktree.snapshot && !worktree.canEdit && (
                <p className="assistant-context">{t("assistantReadOnly")}</p>
              )}
              <div
                ref={log}
                className="assistant-messages"
                role="log"
                aria-label={t("assistantMessages")}
                aria-live="polite"
                aria-relevant="additions"
              >
                {!conversation?.turns.length && !pending && (
                  <div className="assistant-welcome">
                    <MessageSquare size={28} />
                    <h3>{t("assistantWelcome")}</h3>
                    <p>{t("assistantWelcomeHint")}</p>
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
                    {...actionControls(turn)}
                  />
                ))}
                {pending && (
                  <AssistantMessage
                    turn={pending}
                    {...actionControls(pending)}
                  />
                )}
                {busy && (
                  <p className="muted" role="status">
                    {t("assistantThinking")}
                  </p>
                )}
              </div>
              {error && (
                <p className="notice error" role="alert">
                  {explainError(error)}
                </p>
              )}
              <form
                className="assistant-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <label
                  className="assistant-prompt-label"
                  htmlFor="assistant-prompt"
                >
                  {t("assistantMessage")}
                </label>
                <textarea
                  id="assistant-prompt"
                  ref={input}
                  rows={3}
                  maxLength={16000}
                  value={draft}
                  disabled={busy || undoing}
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
                      className="button secondary"
                      type="button"
                      onClick={() => void stop()}
                    >
                      <Square size={14} />
                      {t("assistantStop")}
                    </button>
                  ) : (
                    <button
                      className="button primary"
                      disabled={
                        !draft.trim() ||
                        !selected ||
                        undoing ||
                        (!!worktree.id && !worktree.snapshot)
                      }
                    >
                      <Send size={14} />
                      {t("assistantSend")}
                    </button>
                  )}
                </footer>
              </form>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
