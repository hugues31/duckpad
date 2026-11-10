import { useState } from "react";
import type { PathPart } from "./graph";
import type { Cell } from "./lineageGraph";

export interface FlowLocation {
  worktree: string;
  environment: string;
  path: PathPart[];
  selected: string | null;
  /** The history entry whose `node` parameter was revealed last. */
  revealed: string;
  /** The result cell whose lineage is explained. */
  cell: Cell | null;
  /** Whether the code of the selected node replaces the inspector. */
  code: boolean;
}

/**
 * The opened component, selected node and explained cell of the flow tab.
 * WorktreePage keeps them while other tabs are shown. They reset when another
 * working branch opens, and the explanation when the environment changes.
 */
export function useFlowView(worktree: string, environment: string) {
  const empty: FlowLocation = {
    worktree,
    environment,
    path: [],
    selected: null,
    revealed: "",
    cell: null,
    code: false,
  };
  const [view, setView] = useState(empty);
  if (view.worktree !== worktree) setView(empty);
  else if (view.environment !== environment)
    setView({ ...view, environment, cell: null });
  return {
    ...view,
    change: (update: Partial<FlowLocation>) =>
      setView((current) => ({ ...current, ...update })),
  };
}

export type FlowView = ReturnType<typeof useFlowView>;
