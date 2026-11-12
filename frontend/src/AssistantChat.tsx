import {
  ArrowDown,
  Maximize2,
  Minimize2,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api, send } from "./api";
import { DEBUG_ASSISTANT_EVENT, type DebugRequest } from "./AskAssistant";
import AssistantComposer from "./AssistantComposer";
import { assistantContext } from "./assistantContext";
import { useAssistantError } from "./assistantErrors";
import {
  AssistantLauncher,
  chatPlacement,
  useLauncherPosition,
} from "./AssistantLauncher";
import {
  ActionControls,
  AssistantMessage,
  AssistantThinking,
} from "./AssistantMessage";
import { useDefaultPrompts } from "./AssistantPrompts";
import { useProviderName } from "./assistantProviders";
import type { AssistantTurn, Conversation } from "./assistantTypes";
import AssistantWelcome from "./AssistantWelcome";
import ConversationSidebar from "./ConversationSidebar";
import { resolveNodePath } from "./graph";
import { useT } from "./i18n";
import { trapFocus } from "./modals";
import { projectSettingsUrl, usePageRoute, worktreeUrl } from "./navigation";
import { useShell } from "./shell";
import { useAssistantStream } from "./useAssistantStream";
import { useConversations } from "./useConversations";
import { useFollowScroll } from "./useFollowScroll";
import { useWorktree } from "./worktree";

export default function AssistantChat() {
  const t = useT();
  const providerName = useProviderName();
  const explainError = useAssistantError();
  const { workspace, environment, drafts, openModal } = useShell();
  const worktree = useWorktree();
  const route = usePageRoute();
  const navigate = useNavigate();
  const options = workspace?.assistant;
  const [open, setOpen] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const {
    conversation,
    setConversation,
    conversations,
    nextOffset,
    title,
    setTitle,
    list,
  } = useConversations();
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState("");
  const [undoing, setUndoing] = useState(false);
  // An "Ask the assistant" request arrived during a response; told until idle.
  const [waiting, setWaiting] = useState(false);
  const [seenAnswers, setSeenAnswers] = useState(0);
  const launcherPosition = useLauncherPosition();
  const [debug, setDebug] = useState<
    (DebugRequest & { worktree: string }) | null
  >(null);
  const defaultPrompts = useDefaultPrompts();
  // Whether the log follows new content, and where the reader left it.
  const { log, followingRef, atEnd, followLog, showLatest } =
    useFollowScroll<HTMLDivElement>(open);
  const awaitingApproval =
    conversation?.turns.at(-1)?.status === "awaiting_approval";
  const launcher = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  const context = assistantContext(route, worktree, environment, debug);
  const resolvedNode =
    context.node && worktree.snapshot?.bundle
      ? resolveNodePath(worktree.snapshot.bundle, context.node)?.node
      : null;
  const nodeLabel = resolvedNode?.label || resolvedNode?.id || context.node;
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
  const {
    busy,
    error,
    setError,
    pending,
    setPending,
    continuing,
    answers,
    submit,
    handleDecision,
    stop,
  } = useAssistantStream({
    conversation,
    setConversation,
    setTitle,
    list,
    bound,
    worktree,
    drafts,
    context,
    selected,
    undoing,
    draft,
    setDraft,
    maximized,
    followingRef,
    enabled: !!options?.enabled,
  });
  if (waiting && !busy && !undoing) setWaiting(false);
  useEffect(() => {
    const receive = (event: Event) => {
      setOpen(true);
      if (busy || undoing) {
        setWaiting(true);
        return;
      }
      const detail = (event as CustomEvent<DebugRequest>).detail;
      setDebug({ ...detail, worktree: worktree.id });
      setConversation(null);
      setPending(null);
      setDraft(detail.prompt);
      followingRef.current = true;
    };
    window.addEventListener(DEBUG_ASSISTANT_EVENT, receive);
    return () => window.removeEventListener(DEBUG_ASSISTANT_EVENT, receive);
  }, [busy, undoing, worktree.id, followingRef, setConversation, setPending]);
  // Conflict resolutions happen in the existing workspace dialog.
  useEffect(() => {
    if (!conversation?.id || busy || undoing) return;
    const controller = new AbortController();
    void api<Conversation>(`/assistant/conversations/${conversation.id}`, {
      signal: controller.signal,
    })
      .then((value) => {
        if (!controller.signal.aborted) setConversation(value);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [
    setConversation,
    conversation?.id,
    busy,
    undoing,
    worktree.snapshot?.revision,
    worktree.snapshot?.conflicts,
  ]);

  async function resume(item: Conversation) {
    try {
      const value = await api<Conversation>(
        `/assistant/conversations/${item.id}`,
      );
      followingRef.current = true;
      setConversation(value);
      setDebug(null);
      setTitle(value.title);
      setPending(null);
      setError("");
      if (value.worktree)
        void navigate(worktreeUrl(value.worktree, "flow", environment));
      else if (value.project) void navigate(projectSettingsUrl(value.project));
      else void navigate("/projects");
    } catch (e) {
      setError((e as Error).message);
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
                  followingRef.current = true;
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
              <ConversationSidebar
                conversations={conversations}
                busy={busy}
                undoing={undoing}
                conversation={conversation}
                resume={resume}
                nextOffset={nextOffset}
                list={list}
                setError={setError}
              />
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
                    <AssistantWelcome
                      options={options}
                      defaultPrompts={defaultPrompts}
                      busy={busy}
                      undoing={undoing}
                      selected={selected}
                      submit={submit}
                      branchOpen={!!context.worktree}
                    />
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
              {waiting && (
                <p className="assistant-notice" role="status">
                  {t("assistantRequestWaiting")}
                </p>
              )}
              {awaitingApproval && (
                <p className="assistant-notice">
                  {t("assistantAnswerConfirmation")}
                </p>
              )}
              <AssistantComposer
                submit={submit}
                busy={busy}
                input={input}
                draft={draft}
                undoing={undoing}
                setDraft={setDraft}
                selectedKey={selectedKey}
                setModel={setModel}
                choices={choices}
                providerName={providerName}
                stop={stop}
                awaitingApproval={awaitingApproval}
                selected={selected}
                worktree={worktree}
              />
            </div>
          </div>
        </section>
      )}
    </>
  );
}
