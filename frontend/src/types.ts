export type Json = Record<string, any>;
export type Theme = "light" | "dark";
export interface FlowNode {
  id: string;
  template?: string;
  component?: string;
  label?: string;
  params: Json;
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
  [key: string]: any;
}
export interface Bundle {
  flow: Graph & {
    id: string;
    name: string;
    description?: string;
  };
  templates: Record<string, string>;
  components: Record<string, Json>;
  documentation: Json;
  pyproject?: string | null;
  /** The declarations of variables.json, its raw text when malformed, or null without the file. */
  variables?: Record<string, Json> | string | null;
}
/** A root flow node parameter bound to a project variable. */
export interface VariableUsage {
  node: string;
  label: string;
  param: string;
}
/** A variable's value in one environment, or why it has none. */
export interface VariableValue {
  value?: unknown;
  source?: "default" | "environment";
  error?: string;
}
export interface VariableSummary {
  type: string;
  description: string;
  default?: unknown;
  environments: Record<string, unknown>;
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
export interface Snapshot {
  role: "reader" | "editor" | "admin";
  connections: Json[];
  worktree: Json;
  revision: string;
  commit: string;
  bundle: Bundle | null;
  files: Record<string, string>;
  diagnostics: Json[];
  conflicts: Json[];
  parsed_templates: Record<string, Json>;
  /** Null while the project files cannot be read. */
  variables: VariablesSummary | null;
}
export interface Project {
  role: "admin" | "editor" | "reader";
  id: string;
  name: string;
  main: string;
  created: string;
}
export interface Workspace {
  user: {
    auth_method?: "oidc";
    id: string;
    username: string;
    role: "admin" | "member";
    active: boolean;
  };
  projects: Project[];
  worktrees: Json[];
  catalog: {
    environments: string[];
    environment_details: Environment[];
    connectors: Json[];
    connections: Json[];
    duckdb_version?: string;
  };
}
export interface Environment {
  id: string;
  label: string;
  color: string;
  confirm_before_run: boolean;
}
export interface Statuses {
  nodes: Record<string, Json>;
  active: Json | null;
}
