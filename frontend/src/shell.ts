import { createContext, useContext } from "react";
import type { ModalState } from "./ModalHost";
import type { WorkspaceTab } from "./navigation";
import type { Preferences } from "./preferences";
import type { Workspace } from "./types";
import type { DraftRegistry } from "./useRevisionDraft";
import type { PanelVisibility } from "./WorkspacePanels";

/** The signed-in session shared by the App layout, its pages and dialogs. */
export interface Shell {
  /** Null until the first answer; pages render only once it is loaded. */
  workspace: Workspace | null;
  refreshWorkspace: () => Promise<Workspace>;
  /** The run environment named in the URL, or the first configured one. */
  environment: string;
  preferences: Preferences;
  drafts: DraftRegistry;
  /** Which floating panels of the flow are open, kept for the session. */
  flowPanels: PanelVisibility;
  /** Where `/` leads after signing in: a validated SSO return, if any. */
  signInDestination: string | null;
  notify: (text: string, error?: boolean) => void;
  openModal: (modal: ModalState) => void;
  closeModal: () => void;
  /** Open a working branch in the selected environment. */
  openWorktree: (id: string, tab?: WorkspaceTab) => void;
  /** Show the sign-in page, for instance after a password change. */
  endSession: () => void;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell() {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error("useShell is only available inside App");
  return shell;
}

/** The workspace, for pages that App renders once it is loaded. */
export function useWorkspace() {
  const { workspace } = useShell();
  if (!workspace) throw new Error("The workspace is not loaded");
  return workspace;
}
