import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { api, send, streamAssistant } from "./api";
import { applyAssistantEvent } from "./assistantEvents";
import type {
  AssistantContext,
  AssistantEvent,
  AssistantOptions,
  AssistantTurn,
  Conversation,
} from "./assistantTypes";
import type { useShell } from "./shell";
import type { useWorktree } from "./worktree";
export function useAssistantStream({
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
  enabled,
}: {
  conversation: Conversation | null;
  setConversation: Dispatch<SetStateAction<Conversation | null>>;
  setTitle: (title: string) => void;
  list: () => Promise<void>;
  bound: boolean;
  worktree: ReturnType<typeof useWorktree>;
  drafts: ReturnType<typeof useShell>["drafts"];
  context: AssistantContext;
  selected: AssistantOptions["models"][number] | undefined;
  undoing: boolean;
  draft: string;
  setDraft: (text: string) => void;
  maximized: boolean;
  followingRef: RefObject<boolean>;
  enabled: boolean;
}) {
  const awaitingApproval =
    conversation?.turns.at(-1)?.status === "awaiting_approval";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<AssistantTurn | null>(null);
  const [continuing, setContinuing] = useState("");
  const [answers, setAnswers] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const identity = useRef("");
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!enabled) controller.current?.abort();
  }, [enabled]);
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
      abort.signal.throwIfAborted();
      if (!value || !bound) {
        value = await api<Conversation>("/assistant/conversations", {
          ...send(context),
          signal: abort.signal,
        });
        setConversation(value);
      }
      abort.signal.throwIfAborted();
      identity.current = value.id;
      followingRef.current = true;
      setPending(current);
      setDraft("");
      const receive = (event: AssistantEvent) => {
        current = applyAssistantEvent(current, event);
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
          current = applyAssistantEvent(current, event);
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
  async function stop() {
    if (!identity.current) {
      controller.current?.abort();
      return;
    }
    try {
      await api(`/assistant/conversations/${identity.current}/stop`, send({}));
    } catch (e) {
      controller.current?.abort();
      setError((e as Error).message);
    }
  }
  return {
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
  };
}
