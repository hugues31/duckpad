import type { ProjectExtension } from "./extensions";
/** A value that JSON can represent, such as a parameter set by a user. */
export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };
export type Theme = "light" | "dark";
export interface FlowNode {
  id: string;
  template?: string;
  origin?: string;
  /** Original palette appearance and guided form; never resolves executable code. */
  preset?: string;
  component?: string;
  label?: string;
  params: Record<string, Json>;
  position: { x: number; y: number };
}
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
}
export interface Graph {
  nodes: FlowNode[];
  edges: FlowEdge[];
}
/** What a template does with data. */
export type TemplateKind = "source" | "transform" | "export";
/** A parameter declared by a template or exposed by a component. */
export interface Parameter {
  name: string;
  type: string;
  default?: Json;
}
/** A template's interface, or only the error that prevents parsing it. */
export interface ParsedTemplate {
  error?: string;
  label?: string;
  description?: string;
  kind?: TemplateKind;
  inputs?: string[];
  outputs?: string[];
  parameters?: Parameter[];
  /** The destination parameter and format of an export Duckpad can download. */
  download?: { parameter: string; format: string } | null;
}
/** A port of a component, bound to a port of one of its nodes. */
export interface ComponentPort {
  node: string;
  port: string;
}
export interface ComponentDefinition extends Graph {
  name?: string;
  description?: string;
  inputs?: Record<string, ComponentPort>;
  outputs?: Record<string, ComponentPort>;
  parameters?: Record<
    string,
    Omit<Parameter, "name"> & { targets?: { node: string; param: string }[] }
  >;
}
/** Descriptions of the project's nodes, datasets and columns. */
export interface Documentation {
  project?: string;
  nodes?: Record<string, string>;
  datasets?: Record<string, string>;
  columns?: Record<string, Record<string, string>>;
}
export interface Bundle {
  flow: Graph & {
    id: string;
    name: string;
    description?: string;
  };
  templates: Record<string, string>;
  node_sql?: Record<string, string>;
  components: Record<string, ComponentDefinition>;
  documentation: Documentation;
  pyproject?: string | null;
  /** The declarations of variables.json, its raw text when malformed, or null without the file. */
  variables?: Record<string, Json> | string | null;
  /** Requirements from extensions.json, preserved as raw text when malformed. */
  extensions?: Record<string, ProjectExtension> | string | null;
}
/** A root flow node parameter bound to a project variable. */
export interface VariableUsage {
  node: string;
  label: string;
  param: string;
  /** Whether the parameter references the variable inside its expression text. */
  expression?: boolean;
}
/** A variable's value in one environment, or why it has none. */
export interface VariableValue {
  value?: Json;
  source?: "default" | "environment";
  error?: string;
}
export interface VariableSummary {
  type: string;
  description: string;
  default?: Json;
  environments: Record<string, Json>;
  errors: string[];
  warnings: string[];
  values: Record<string, VariableValue>;
  usages: VariableUsage[];
}
/** What the snapshot reports about variables.json, for the interface. */
export interface VariablesSummary {
  file_error: string | null;
  declarations: Record<string, VariableSummary>;
  /** References to variables that variables.json does not declare. */
  undeclared: Record<string, VariableUsage[]>;
  diagnostics: Json[];
  warnings: Json[];
}
export type ProjectRole = "admin" | "editor" | "reader";
export interface Worktree {
  id: string;
  project: string;
  branch: string;
}
/** A save that conflicted with concurrent edits, with both versions of the files. */
export interface Conflict {
  id: string;
  paths: string[];
  current: Record<string, string>;
  proposal: Record<string, string>;
}
export interface Diagnostic {
  file: string;
  message: string;
  variable?: string;
  node?: string;
}
export type Capability = "read" | "write";
export interface Snapshot {
  role: ProjectRole;
  /** The connections granted to the project. */
  connections: { id: string; name: string; capabilities: Capability[] }[];
  worktree: Worktree;
  revision: string;
  commit: string;
  bundle: Bundle | null;
  files: Record<string, string>;
  diagnostics: Diagnostic[];
  conflicts: Conflict[];
  parsed_templates: Record<string, ParsedTemplate>;
  parsed_nodes?: Record<string, ParsedTemplate>;
  /** Null while the project files cannot be read. */
  variables: VariablesSummary | null;
}
export interface Project {
  role: ProjectRole;
  id: string;
  name: string;
  main: string;
  created: string;
}
export interface ConnectorParameter {
  name: string;
  /** Text when omitted. */
  type?: string;
  default?: Json;
  secret?: boolean;
}
/** A connector definition, as written by an administrator. */
export interface Connector {
  id: string;
  name?: string;
  description?: string;
  compatibility?: string;
  capabilities?: Capability[];
  parameters?: ConnectorParameter[];
}
export interface Connection {
  id: string;
  name: string;
  connector: string;
  /** Parameter values per environment; secrets are masked. */
  environments: Record<string, Record<string, Json>>;
}
/** An instance account, as shown to administrators. */
export interface User {
  id: string;
  username: string;
  role: "admin" | "member";
  active: boolean;
  /** Present when the account signs in with single sign-on. */
  auth_method?: "oidc";
}
export interface Workspace {
  assistant?: import("./assistantTypes").AssistantOptions;
  user: User;
  projects: Project[];
  worktrees: Worktree[];
  catalog: {
    environments: string[];
    environment_details: Environment[];
    connectors: Connector[];
    connections: Connection[];
    duckdb_version?: string;
  };
}
export interface Environment {
  id: string;
  label: string;
  color: string;
  confirm_before_run: boolean;
}
export interface Column {
  name: string;
  type: string;
}
/** A materialized output of a node. */
export interface Dataset {
  id: string;
  node: string;
  port: string;
  columns: Column[];
  count: number;
  run: string;
  status: "valid" | "stale";
  created: string;
}
/** A SQL statement compiled from a template block. */
export interface Statement {
  output: string | null;
  sql: string;
  /** Parameter values bound to the statement's placeholders. */
  bindings: Record<string, Json>;
  /** What a run executed to store the statement's output. */
  materialization_sql?: string[];
  variables?: (VariableValue & {
    name: string;
    type: string | null;
    parameter: string;
    /** The named parameter binding a variable referenced inside an expression. */
    binding?: string;
  })[];
}
/** A page of rows of a node output, with the dataset holding them. */
export interface PreviewPage extends Dataset {
  results?: ExecutionResult[];
  rows: { id: number; values: Json[] }[];
  /** Rows matching the filters, across all pages. */
  filtered_count: number;
  offset: number;
  /** The statements of the run that produced the dataset. */
  executed_sql: Statement[];
  commit: string;
  environment: string;
  /** The error of the node's latest run, if it failed after this result. */
  error: string | null;
}
export type RunStatus =
  | "preparing"
  | "running"
  | "canceling"
  | "success"
  | "partial_failure"
  | "failed"
  | "canceled"
  | "interrupted";
export type NodeRunStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "blocked"
  | "canceled"
  | "interrupted";
/** A redacted result emitted by a message block or another execution check. */
export interface ExecutionResult {
  level: "info" | "warning" | "error";
  message: string;
  origin: { kind: string; block?: number; name?: string };
  output?: string | null;
  observed?: Json;
  /** A final summary preserves counts for results beyond the display limit. */
  omitted?: number;
  counts?: Partial<Record<ExecutionResult["level"], number>>;
}
/** What a run did with one node. */
export interface NodeRun {
  results?: ExecutionResult[];
  status: NodeRunStatus;
  label: string;
  kind: TemplateKind;
  outputs?: Record<string, Dataset>;
  error?: string;
  duration?: number;
  external_outcome?: "completed" | "failed" | "partial or unknown" | "unknown";
  statements?: Statement[];
  /** Parameter -> the variable bound to it. */
  variables?: Record<string, string>;
  /** Parameter -> the variables its expression references. */
  references?: Record<string, string[]>;
}
export interface Run {
  warning_count?: number;
  id: string;
  project: string;
  worktree: string;
  branch: string;
  environment: string;
  commit: string;
  /** The node whose subtree ran, or "project". */
  scope: string;
  trigger: string;
  entry_point: "ui" | "api";
  status: RunStatus;
  started: string;
  finished?: string | null;
  duration?: number | null;
  /** Why the run stopped before running its nodes. */
  error?: string;
  nodes: Record<string, NodeRun>;
  variables?: Record<string, VariableValue & { type: string | null }>;
  /** The connections, templates and components the run used, without secrets. */
  connections: Record<string, Json>;
  node_sql?: Record<string, string>;
  definitions: Record<string, string>;
  components: Record<string, ComponentDefinition>;
}
/** The latest results of a node in an environment. */
export interface NodeResult {
  results?: ExecutionResult[];
  result_run?: string;
  outputs: Record<string, Dataset>;
  error: string | null;
  execution_status?: NodeRunStatus | null;
}
export interface Statuses {
  nodes: Record<string, NodeResult>;
  active: Run | null;
}
