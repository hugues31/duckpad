import type { ProjectRole } from "./types";

interface Member {
  id: string;
  username: string;
  active: boolean;
  role: ProjectRole;
  auth_method?: "oidc" | "service";
}

export interface Settings {
  python: { enabled: boolean; allow_builds: boolean };
  project: { name: string };
  /** The role of the signed-in user. */
  role: ProjectRole;
  members: Member[];
  /** Active accounts that can join the project; listed for its admins only. */
  users: { id: string; username: string; auth_method?: "oidc" | "service" }[];
  /** The granted connections. */
  connections: string[];
}

export type Confirmation =
  { kind: "delete" } | { kind: "remove"; member: Member };
