import type { Area, WorkspaceTab } from "./navigation";

export type ProviderKind =
  | "openai"
  | "anthropic"
  | "google"
  | "mistral"
  | "deepseek"
  | "ollama"
  | "custom";
export interface AssistantProvider {
  id: string;
  kind: ProviderKind;
  base_url: string;
  models: string[];
  has_key?: boolean;
  api_key?: string;
}
export interface AssistantSettings {
  enabled: boolean;
  allow_data: boolean;
  max_rows: number;
  providers: AssistantProvider[];
  default_provider: string;
  default_model: string;
}
export interface AssistantOptions {
  enabled: boolean;
  allow_data: boolean;
  max_rows: number;
  models: { provider: string; kind: ProviderKind; model: string }[];
  default_provider: string;
  default_model: string;
}
export interface AssistantContext {
  page: Area;
  tab?: WorkspaceTab;
  section?: string;
  project: string | null;
  worktree: string;
  branch: string;
  node: string;
  file: string;
  environment: string;
  node_name?: string;
  project_name?: string;
}
export interface AssistantTool {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: string;
  summary: string;
}
export interface AssistantTurn {
  user: string;
  text: string;
  tools: AssistantTool[];
  context: AssistantContext;
  provider: string;
  model: string;
  status: string;
  error: string;
}
export interface Conversation {
  id: string;
  project: string | null;
  worktree: string;
  branch: string;
  title: string;
  updated: string;
  turns: AssistantTurn[];
}
export type AssistantEvent =
  | { type: "start"; conversation: string }
  | { type: "text"; text: string }
  | { type: "tool"; tool: AssistantTool }
  | { type: "done"; turn: AssistantTurn };
