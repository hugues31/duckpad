import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api, send } from "./api";
import {
  DEFAULT_SAMPLE,
  type DraftPreview,
  type PreviewState,
  type SampleSize,
} from "./draftPreview";
import { useT } from "./i18n";
import { previewError } from "./previewError";
import type { ResultsTab } from "./results";
import type { FlowNode, Statuses } from "./types";
import type { useLoadedWorktree } from "./worktree";
export function useDraftPreview({
  node,
  fullNode,
  worktree,
  environment,
  canEdit,
  statuses,
  run,
  showResults,
}: {
  node: FlowNode | undefined;
  fullNode: string;
  worktree: string;
  environment: string;
  canEdit: boolean;
  statuses: Statuses;
  run: ReturnType<typeof useLoadedWorktree>["run"];
  showResults: (tab: ResultsTab) => void;
}) {
  const t = useT();
  // The preview of the selected node, computed from samples of its inputs.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [sample, setSample] = useState<SampleSize>(DEFAULT_SAMPLE);
  const previewRequest = useRef<AbortController | null>(null);
  // The code being edited in the code panel, which previews compute.
  const codeDraft = useRef<{ node: string; code: string } | null>(null);
  // The node to preview again once the run of its ancestors, when it starts, ends.
  const previewAfterRun = useRef<{ node: string; run: string | null } | null>(
    null,
  );
  /** Compute the selected node's code, or its draft, on samples of its inputs. */
  async function requestPreview(code?: string, rows: SampleSize = sample) {
    if (!node || !canEdit) return;
    const target = fullNode;
    const draft =
      code ??
      (codeDraft.current?.node === target ? codeDraft.current.code : undefined);
    previewRequest.current?.abort();
    const request = new AbortController();
    previewRequest.current = request;
    // The previous rows stay visible, dimmed, until the new ones arrive.
    setPreview((current) => ({
      node: target,
      environment,
      pending: true,
      result: current?.node === target ? current.result : undefined,
    }));
    showResults("preview");
    try {
      const result = await api<DraftPreview>(
        `/worktrees/${worktree}/draft-preview/${encodeURIComponent(target)}`,
        {
          ...send({ environment, code: draft, rows }),
          signal: request.signal,
        },
      );
      if (request.signal.aborted) return;
      setPreview({ node: target, environment, pending: false, result });
    } catch (error) {
      if (request.signal.aborted) return;
      setPreview({
        node: target,
        environment,
        pending: false,
        ...previewError(error, t),
      });
    }
  }
  const previewAgain = useEffectEvent((active: string | null) => {
    const waiting = previewAfterRun.current;
    if (waiting?.node !== fullNode) return;
    // The run of these ancestors, once it starts; a run that fails to start leaves none.
    if (active) {
      if (statuses.active?.ancestors && statuses.active.scope === waiting.node)
        waiting.run ??= active;
    } else if (waiting.run) {
      previewAfterRun.current = null;
      void requestPreview();
    }
  });
  // Once the ancestors have run, preview again what they were computed for.
  const activeRun = statuses.active?.id ?? null;
  useEffect(() => previewAgain(activeRun), [activeRun]);
  const runAncestors = () => {
    previewAfterRun.current = { node: fullNode, run: null };
    void run(fullNode, { ancestors: true });
  };

  useEffect(() => () => previewRequest.current?.abort(), []);
  const clearPreview = () => {
    previewRequest.current?.abort();
    previewAfterRun.current = null;
    setPreview(null);
  };
  const updateDraft = (code: string | null) => {
    codeDraft.current = code === null ? null : { node: fullNode, code };
  };
  return {
    preview,
    sample,
    setSample,
    requestPreview,
    runAncestors,
    clearPreview,
    updateDraft,
  };
}
