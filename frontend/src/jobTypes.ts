import type { Comparison } from "./gitTypes";
import type { Run } from "./types";
export interface Target {
  kind: "tag" | "branch";
  tag?: string;
  branch?: string;
  commit?: string;
}
export interface Job {
  slug: string;
  name: string;
  description: string;
  worktree: string;
  environment: string;
  scope: string | null;
  target: Target;
  revision: string;
  warning: "tag_moved" | "target_unavailable" | null;
  resolved_commit: string | null;
  last_run: Run | null;
  versions: {
    at: string;
    actor: { username: string };
    previous: Target | null;
    target: Target;
    previous_commit: string | null;
    commit: string;
  }[];
}
export interface Review {
  revision: string;
  previous_commit: string;
  commit: string;
  comparison: Comparison;
}
export const active = (run: Run | null) =>
  !!run && ["preparing", "running", "canceling"].includes(run.status);
export const version = (target: Target) => target.tag || target.branch;
