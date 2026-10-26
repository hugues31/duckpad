export type Json = Record<string, any>;
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
export interface Bundle {
  flow: {
    id: string;
    name: string;
    description?: string;
    nodes: FlowNode[];
    edges: FlowEdge[];
  };
  templates: Record<string, string>;
  components: Record<string, Json>;
  documentation: Json;
}
export interface Snapshot {
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
  id: string;
  name: string;
  main: string;
  created: string;
}
export interface Workspace {
  projects: Project[];
  worktrees: Json[];
  catalog: Json;
  identity: Json;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public detail?: any,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch("/api" + path, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      result.error || result.detail || "Request failed",
      response.status,
      result.detail,
    );
  return result;
}
export const send = (data: unknown, method = "POST"): RequestInit => ({
  method,
  body: JSON.stringify(data),
});
export const identifier = (prefix = "node") =>
  prefix + "_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
export const formatValue = (value: any) =>
  value === null
    ? "NULL"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
