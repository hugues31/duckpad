import { useCallback, useEffect, useState } from "react";
import {
  Outlet,
  useBeforeUnload,
  useBlocker,
  useLocation,
  useNavigate,
} from "react-router";
import { Loader2 } from "lucide-react";
import { api, onSessionExpired, send } from "./api";
import DuckMark from "./DuckMark";
import ErrorBoundary from "./ErrorBoundary";
import { I18n, useT } from "./i18n";
import LoginPage from "./LoginPage";
import ModalHost, { type ModalState } from "./ModalHost";
import { Modal } from "./modals";
import { PageLoading } from "./pages/PageStates";
import {
  SSO_RETURN_KEY,
  usePageRoute,
  worktreeUrl,
  type WorkspaceTab,
} from "./navigation";
import { usePreferences, type Preferences } from "./preferences";
import { isWorktreePage, signInReturn } from "./routes";
import InstanceSearch from "./Search";
import { useSearchShortcut } from "./searchShortcuts";
import { ShellContext, type Shell } from "./shell";
import { Toast, useToast } from "./Toast";
import TopBar from "./TopBar";
import type { Workspace } from "./types";
import { usePolling } from "./usePolling";
import { usePanelVisibility } from "./WorkspacePanels";
import {
  DraftContext,
  useDraftRegistry,
  type DraftRegistry,
} from "./useRevisionDraft";
import { useWorktree, WorktreeProvider } from "./worktree";

const WORKSPACE_INTERVAL = 5000;

/** The persistent layout around every page of `routes.tsx`. */
export default function App() {
  const preferences = usePreferences();
  const drafts = useDraftRegistry();
  return (
    <I18n.Provider
      value={{
        language: preferences.language,
        setLanguage: preferences.setLanguage,
      }}
    >
      <DraftContext.Provider value={drafts.register}>
        <ErrorBoundary>
          <Session preferences={preferences} drafts={drafts} />
        </ErrorBoundary>
      </DraftContext.Provider>
    </I18n.Provider>
  );
}

/** Show the sign-in page until the API accepts the session. */
function Session({
  preferences,
  drafts,
}: {
  preferences: Preferences;
  /** Unsaved drafts of the mounted editors. */
  drafts: DraftRegistry;
}) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [signInDestination] = useState(() =>
    signInReturn(sessionStorage.getItem(SSO_RETURN_KEY)),
  );
  const endSession = useCallback(() => setAuthenticated(false), []);
  useEffect(() => onSessionExpired(endSession), [endSession]);
  useEffect(() => {
    api("/session")
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);
  usePageTitle();
  if (authenticated === null)
    return (
      <div className="startup">
        <DuckMark size={48} />
        <Loader2 className="spin" />
      </div>
    );
  if (!authenticated)
    return (
      <LoginPage
        preferences={preferences}
        onSuccess={() => setAuthenticated(true)}
      />
    );
  return (
    <SignedIn
      preferences={preferences}
      drafts={drafts}
      signInDestination={signInDestination}
      endSession={endSession}
    />
  );
}

function usePageTitle() {
  const t = useT();
  const { area, tab = "flow" } = usePageRoute();
  const title = t(
    area === "pipelines"
      ? tab
      : area === "home"
        ? "projects"
        : area === "notFound"
          ? "routeNotFound"
          : area,
  );
  useEffect(() => {
    document.title = `${title} · Duckpad`;
  }, [title]);
}

/** The workspace, the open working branch and the dialogs of a session. */
function SignedIn({
  preferences,
  drafts,
  signInDestination,
  endSession,
}: {
  preferences: Preferences;
  drafts: DraftRegistry;
  signInDestination: string | null;
  endSession: () => void;
}) {
  const { message, notify, dismiss } = useToast();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const route = usePageRoute();
  const location = useLocation();
  const navigate = useNavigate();
  const worktree = (route.area === "pipelines" && route.worktreeId) || "";
  const tab = route.tab || "flow";
  const environments = workspace?.catalog.environments || [];
  const requestedEnvironment = new URLSearchParams(location.search).get(
    "environment",
  );
  const environment =
    requestedEnvironment && environments.includes(requestedEnvironment)
      ? requestedEnvironment
      : environments[0] || "";
  // The Pipelines link returns to the branch opened last, or to the main
  // branch of a project whose settings are open and whose branches were not.
  const [lastWorktree, setLastWorktree] = useState("");
  if (worktree && worktree !== lastWorktree) setLastWorktree(worktree);
  const last = workspace?.worktrees.find((w) => w.id === lastWorktree);
  const settingsProject =
    route.area === "projectSettings"
      ? workspace?.projects.find((p) => p.id === route.projectId)
      : undefined;
  const pipeline =
    settingsProject && last?.project !== settingsProject.id
      ? settingsProject.main
      : last?.id;
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useSearchShortcut(workspace ? "k" : undefined, openSearch);
  const closeModal = useCallback(() => setModal(null), []);
  const flowPanels = usePanelVisibility();

  const refreshWorkspace = useCallback(async () => {
    const value = await api<Workspace>("/workspace");
    setWorkspace(value);
    return value;
  }, []);
  useEffect(() => {
    void refreshWorkspace().catch((e) => notify(e.message, true));
  }, [refreshWorkspace, notify, location.key]);
  // Membership and branch changes made elsewhere appear without a reload.
  usePolling(
    () => refreshWorkspace().then(() => undefined),
    { interval: WORKSPACE_INTERVAL, delay: WORKSPACE_INTERVAL },
    [refreshWorkspace],
  );
  useEffect(() => {
    if (
      workspace &&
      worktree &&
      requestedEnvironment &&
      !environments.includes(requestedEnvironment)
    )
      void navigate(worktreeUrl(worktree, tab, environment), {
        replace: true,
      });
  }, [workspace, worktree, tab, environment, requestedEnvironment, navigate]);
  useEffect(() => {
    setModal(null);
  }, [location.pathname]);

  const shell: Shell = {
    workspace,
    refreshWorkspace,
    environment,
    preferences,
    drafts,
    flowPanels,
    signInDestination,
    notify,
    openModal: setModal,
    closeModal,
    openWorktree: (id: string, target: WorkspaceTab = "flow") =>
      void navigate(worktreeUrl(id, target, environment)),
    endSession,
  };
  const signOut = async () => {
    try {
      await api("/logout", send({}));
      endSession();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  return (
    <ShellContext.Provider value={shell}>
      <WorktreeProvider worktree={worktree}>
        <div className="app-shell">
          <div className="workspace-shell">
            <TopBar
              pipelineUrl={
                pipeline
                  ? worktreeUrl(pipeline, "flow", environment)
                  : "/projects"
              }
              onSearch={openSearch}
              onSignOut={signOut}
            />
            {searchOpen && workspace && (
              <InstanceSearch
                workspace={workspace}
                environment={environment}
                onClose={() => setSearchOpen(false)}
              />
            )}
            {workspace ? <Outlet /> : <PageLoading />}
          </div>
          <NavigationGuard drafts={drafts} />
          <PageFocus ready={!!workspace} />
          <Toast message={message} onDismiss={dismiss} />
          <ModalHost modal={modal} onClose={closeModal} />
        </div>
      </WorktreeProvider>
    </ShellContext.Provider>
  );
}

/** Confirm before a navigation discards unsaved drafts or an ongoing save. */
function NavigationGuard({ drafts }: { drafts: DraftRegistry }) {
  const t = useT();
  const { area } = usePageRoute();
  const { id: worktree, saving } = useWorktree();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    // Router history can advance before an unmounted editor's cleanup runs.
    // Only drafts belonging to the page being left may block a transition.
    const leavesPage = currentLocation.pathname !== nextLocation.pathname;
    if (!isWorktreePage(currentLocation.pathname, worktree))
      return area === "projectSettings" && leavesPage && drafts.dirty("page");
    const leavesWorktree = !isWorktreePage(nextLocation.pathname, worktree);
    return (
      (drafts.dirty("worktree") && leavesWorktree) ||
      ((drafts.dirty("page") || saving) && leavesPage)
    );
  });
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (drafts.dirty() || saving) event.preventDefault();
      },
      [drafts, saving],
    ),
  );
  if (blocker.state !== "blocked") return null;
  return (
    <Modal title={t("unsavedChanges")} onClose={() => blocker.reset()}>
      <p>{t("leavePageHint")}</p>
      <footer>
        <button
          className="button secondary"
          autoFocus
          onClick={() => blocker.reset()}
        >
          {t("stayOnPage")}
        </button>
        <button
          className="button primary"
          onClick={() => {
            // Discard explicitly even if Back interrupts the route render.
            drafts.discard(
              isWorktreePage(blocker.location.pathname, worktree)
                ? "page"
                : undefined,
            );
            blocker.proceed();
          }}
        >
          {t("leavePage")}
        </button>
      </footer>
    </Modal>
  );
}

/** Move the focus to the heading of each newly opened page. */
function PageFocus({ ready }: { ready: boolean }) {
  const { pathname } = useLocation();
  const loaded = !!useWorktree().snapshot;
  useEffect(() => {
    if (!ready) return;
    const frame = requestAnimationFrame(() => {
      // Do not steal focus if the user already reached a control on the new page.
      if (
        document.activeElement !== document.body &&
        !document.activeElement?.closest(".topbar")
      )
        return;
      const target = document.querySelector<HTMLElement>(
        "h1, .flow-toolbar, .empty-state",
      );
      if (target) {
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, ready, loaded]);
  return null;
}
