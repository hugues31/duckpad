import type { Diagnostic, FlowEdge, Json, VariableUsage } from "./types";

export type ChangeStatus = "added" | "removed" | "modified" | "unchanged";
export type ChangeCategory = "processing" | "documentation" | "layout";

/** An element of the project definitions, compared between two versions. */
interface Change<Kind extends string, Value> {
  id: string;
  kind: Kind;
  name: string;
  file: string;
  /** The component graph holding the element, or "" for the flow. */
  scope: string;
  /** The value in each version, or null where the element is absent. */
  before: Value | null;
  after: Value | null;
  status: ChangeStatus;
  /** Paths of the changed fields. */
  fields: string[];
  categories: ChangeCategory[];
}

/** A node as the comparison graph reads it; other fields are only listed. */
export type NodeChange = Change<
  "node",
  { position?: { x: number; y: number } }
>;
export type EdgeChange = Change<"edge", FlowEdge>;
/**
 * A compared element. Templates hold their SQL text; files hold their text, or
 * the value of a file that is not a valid definition; other elements hold
 * their definition.
 */
export type EntityChange =
  | NodeChange
  | EdgeChange
  | Change<"template", string>
  | (Change<"variable", Json> & { usages?: VariableUsage[] })
  | Change<"flow" | "component" | "documentation" | "file", Json>;

/** The leaf node and port behind each port of a component instance. */
interface Boundary {
  inputs: Record<string, [node: string, port: string]>;
  outputs: Record<string, [node: string, port: string]>;
}

/** Static dependencies of the processing changes, without reading any source. */
export interface Impact {
  status: "partial" | "not_applicable";
  reason: string;
  /** Node instances whose processing or wiring changed. */
  direct: string[];
  downstream: string[];
  /** Expansion errors, or the comparison diagnostics when files are malformed. */
  diagnostics: { node?: string; side?: "before" | "after"; message: string }[];
  before_wiring: FlowEdge[];
  after_wiring: FlowEdge[];
  /** Boundary ports of each component instance, shown as JSON. */
  before_scopes: Record<string, Boundary>;
  after_scopes: Record<string, Boundary>;
}

export interface ComparisonReport {
  entities: EntityChange[];
  counts: Partial<Record<ChangeStatus, number>>;
  categories: Record<ChangeCategory, number>;
  diagnostics: { side?: "before" | "after"; message: string }[];
  impact: Impact;
}

/** One side of a comparison: a commit, frozen working files or the empty tree. */
export interface Revision {
  /** The resolved revision, which compares the same files again. */
  ref: string;
  name: string;
  /** The commit, or the HEAD of frozen files; null for the empty tree. */
  commit: string | null;
  parents: string[];
  /** Commit details, absent for the empty tree. */
  author?: string;
  assistant?: string;
  date?: string;
  message?: string;
  /** When the working files were frozen. */
  captured?: string;
}

export interface Comparison extends ComparisonReport {
  a: Revision;
  b: Revision;
}

export interface Commit {
  commit: string;
  author: string;
  assistant?: string;
  date: string;
  parents: string[];
  /** The subject line. */
  message: string;
}

export interface HistoryPage {
  items: Commit[];
  /** The resolved starting commit, from which the next pages are read. */
  head: string;
  /** Offset of the next page, or null on the last one. */
  next: number | null;
}

export type SyncState =
  | "disconnected"
  | "unverified"
  | "new_remote_branch"
  | "remote_deleted"
  | "unrelated"
  | "up_to_date"
  | "ahead"
  | "behind"
  | "diverged";

export interface Branch {
  /** Full reference name, under refs/heads or refs/remotes/origin. */
  ref: string;
  name: string;
  head: string;
  /** Fetched from origin rather than local. */
  remote: boolean;
  current: boolean;
  /** The worktree open on this local branch. */
  worktree: string | null;
  state: "pending" | "clean" | "closed";
  /** The origin branch that this branch's worktree synchronizes with. */
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  sync_state: SyncState | null;
}

/** The origin of a project and its synchronization with a worktree's branch. */
export interface RemoteStatus {
  url: string | null;
  config_revision: string;
  local_branch: string;
  remote_branch: string | null;
  local_head: string;
  remote_head: string | null;
  state: SyncState;
  ahead: number | null;
  behind: number | null;
  /** When origin was last fetched. */
  checked: string | null;
  /** Why the worktree cannot synchronize yet, such as pending saves. */
  pending: string | null;
}

export type MergeChoice = "base" | "current" | "incoming";

interface ConflictValue {
  /** False when the field does not exist in this version. */
  present: boolean;
  /** The field's value, or null when absent. */
  value: Json;
}

/** A field changed on both sides, with its value in each version. */
export interface MergeConflict {
  path: string;
  choice: MergeChoice | null;
  base: ConflictValue;
  current: ConflictValue;
  incoming: ConflictValue;
}

/** A merge proposed into a worktree, with the changes it would make there. */
export interface MergeReview {
  id: string;
  /** The destination worktree. */
  worktree: string;
  /** The reviewed branch, under refs/heads or refs/remotes. */
  source_ref: string;
  source: string;
  destination: string;
  /** The worktree open on a local source branch. */
  source_worktree: string | null;
  base_head: string;
  source_head: string;
  target_head: string;
  choices: Record<string, MergeChoice>;
  conflicts: MergeConflict[];
  /** Paths of the conflicts without a choice. */
  unresolved: string[];
  diagnostics: Diagnostic[];
  proposal_revision: string;
  comparison: ComparisonReport;
}
