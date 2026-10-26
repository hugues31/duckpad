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
    id: string;
    username: string;
    role: "admin" | "member";
    active: boolean;
  };
  projects: Project[];
  worktrees: Json[];
  catalog: Json;
  identity: Json;
}
export interface Statuses {
  nodes: Record<string, Json>;
  active: Json | null;
}
