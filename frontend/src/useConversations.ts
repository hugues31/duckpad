import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { Conversation } from "./assistantTypes";
export function useConversations() {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const requests = useRef<AbortController | null>(null);
  useEffect(() => () => requests.current?.abort(), []);
  async function list(offset = 0) {
    requests.current?.abort();
    const request = new AbortController();
    requests.current = request;
    try {
      const result = await api<{
        items: Conversation[];
        next_offset: number | null;
      }>(`/assistant/conversations?offset=${offset}`, {
        signal: request.signal,
      });
      if (request.signal.aborted) return;
      setConversations((current) =>
        offset ? [...current, ...result.items] : result.items,
      );
      setNextOffset(result.next_offset);
    } catch (error) {
      if (!request.signal.aborted) throw error;
    }
  }
  return {
    conversation,
    setConversation,
    conversations,
    nextOffset,
    title,
    setTitle,
    list,
  };
}
