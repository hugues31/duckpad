import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Outlet,
  useBeforeUnload,
  useBlocker,
  useLocation,
  useNavigate,
} from "react-router";
import { Loader2 } from "lucide-react";
import { api, onSessionExpired, send } from "./api";
import AssistantChat from "./AssistantChat";
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
import ProjectTabs from "./ProjectTabs";
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
  const language = useMemo(
    () => ({
      language: preferences.language,
      setLanguage: preferences.setLanguage,
    }),
    [preferences.language, preferences.setLanguage],
  );
  return (
    <I18n.Provider value={language}>
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
  // Project tabs carry their branch in the URL; other pages return to the
  // last open pipeline. A project page without branch context uses the branch
  // of that project opened last, then main.
  const [lastWorktree, setLastWorktree] = useState("");
  if (worktree && worktree !== lastWorktree) setLastWorktree(worktree);
  const last = workspace?.worktrees.find((w) => w.id === lastWorktree);
  const settingsProject =
    route.area === "projectSettings" || route.area === "jobs"
      ? workspace?.projects.find((p) => p.id === route.projectId)
      : undefined;
  const projectWorktree = (id: string | null) =>
    workspace?.worktrees.find(
      (w) => w.id === id && w.project === settingsProject?.id,
    )?.id;
  const contextWorktree = settingsProject
    ? projectWorktree(new URLSearchParams(location.search).get("worktree")) ||
      projectWorktree(lastWorktree) ||
      settingsProject.main
    : "";
  const pipeline = contextWorktree || last?.id;
  const worktreeSettings =
    route.area === "projectSettings" &&
    ["partitions", "extensions"].includes(route.section || "");
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useSearchShortcut(workspace ? "k" : undefined, openSearch);
  const closeModal = useCallback(() => setModal(null), []);
  const flowPanels = usePanelVisibility();

  const refreshWorkspace = useCallback(async () => {
    const value = await api<Workspace>("/workspace");
    setWorkspace((previous) =>
      JSON.stringify(previous) === JSON.stringify(value) ? previous : value,
    );
    return value;
  }, []);
  // Membership and branch changes made elsewhere appear without a reload.
  usePolling(
    useCallback(async () => {
      try {
        await refreshWorkspace();
      } catch (error) {
        notify((error as Error).message, true);
        throw error;
      }
    }, [refreshWorkspace, notify]),
    { interval: WORKSPACE_INTERVAL },
  );
  const unknownEnvironment =
    !!workspace &&
    !!requestedEnvironment &&
    requestedEnvironment !== environment;
  useEffect(() => {
    if (worktree && unknownEnvironment)
      void navigate(worktreeUrl(worktree, tab, environment), {
        replace: true,
      });
  }, [worktree, unknownEnvironment, tab, environment, navigate]);
  // A dialog belongs to the page that opened it.
  const [modalPage, setModalPage] = useState(location.pathname);
  if (location.pathname !== modalPage) {
    setModalPage(location.pathname);
    setModal(null);
  }

  const shell = useMemo<Shell>(
    () => ({
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
    }),
    [
      workspace,
      refreshWorkspace,
      environment,
      preferences,
      drafts,
      flowPanels,
      signInDestination,
      notify,
      closeModal,
      navigate,
      endSession,
    ],
  );
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
      <WorktreeProvider
        worktree={
          worktree ||
          (worktreeSettings
            ? contextWorktree
            : modal && "worktree" in modal
              ? modal.worktree
              : "")
        }
      >
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
                currentWorktree={worktree || contextWorktree}
                workspace={workspace}
                environment={environment}
                onClose={() => setSearchOpen(false)}
              />
            )}
            {settingsProject && contextWorktree && (
              <div className="flow-toolbar project-toolbar">
                <ProjectTabs
                  project={settingsProject.id}
                  worktree={contextWorktree}
                  environment={environment}
                />
              </div>
            )}
            {workspace ? <Outlet /> : <PageLoading />}
          </div>
          <AssistantChat />
          <NavigationGuard drafts={drafts} />
          <PageFocus ready={!!workspace} />
          <Toast message={message} onDismiss={dismiss} />
          <ModalHost modal={modal} onClose={closeModal} />
        </div>
      </WorktreeProvider>
    </ShellContext.Provider>
  );
}

/** Finish autosaves before navigation; confirm only edits that can still be discarded. */
function NavigationGuard({ drafts }: { drafts: DraftRegistry }) {
  const { area, section } = usePageRoute();
  const { id: worktree, saving } = useWorktree();
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    // Router history can advance before an unmounted editor's cleanup runs.
    // Only drafts belonging to the page being left may block a transition.
    const leavesPage = currentLocation.pathname !== nextLocation.pathname;
    if (!isWorktreePage(currentLocation.pathname, worktree)) {
      const changesPartitionContext =
        section === "partitions" &&
        ["worktree", "environment"].some(
          (key) =>
            new URLSearchParams(currentLocation.search).get(key) !==
            new URLSearchParams(nextLocation.search).get(key),
        );
      return (
        (area === "projectSettings" || area === "instanceSettings") &&
        (leavesPage || changesPartitionContext) &&
        (drafts.dirty("page") || saving)
      );
    }
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
    <PendingNavigation
      key={blocker.location.key}
      blocker={blocker}
      drafts={drafts}
    />
  );
}

function PendingNavigation({
  blocker,
  drafts,
}: {
  blocker: Extract<ReturnType<typeof useBlocker>, { state: "blocked" }>;
  drafts: DraftRegistry;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { id: worktree, flush, saving } = useWorktree();
  const scope = isWorktreePage(blocker.location.pathname, worktree)
    ? "page"
    : undefined;
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const finished = useRef(false);
  const finish = useCallback(
    (leave: boolean) => {
      // Discard updates the registry before the route unmounts. Resolve each
      // blocked navigation only once, even if that update reruns the effect.
      if (finished.current) return;
      finished.current = true;
      if (!leave) return blocker.reset();
      try {
        blocker.proceed();
      } catch {
        // The router renders blocker changes in a transition. A navigation that
        // completed meanwhile, such as a command selecting what it created,
        // already released this one: replay it rather than proceed.
        void navigate(blocker.location);
      }
    },
    [blocker, navigate],
  );
  const settle = useEffectEvent(async () => {
    // Back can leave a field focused. Finish its blur now, so focusing an
    // error dialog cannot start another save after the failure was reported.
    const blur = () => {
      if (document.activeElement instanceof HTMLElement)
        document.activeElement.blur();
    };
    blur();
    // A tab click can blur a field before the router blocks it. That request
    // cannot be discarded: wait for it, then save any remaining automatic drafts.
    try {
      await flush();
      await drafts.autosave(scope);
      await flush();
    } catch (error) {
      // The user may have resumed typing while the save was pending. Settle
      // that field's blur too, before offering a choice about what remains.
      blur();
      await Promise.resolve();
      await flush().catch(() => undefined);
      throw error;
    }
  });
  useEffect(() => {
    let live = true;
    settle()
      .catch((error: Error) => {
        if (live) setError(error.message);
      })
      .finally(() => {
        if (live) setPending(false);
      });
    return () => {
      live = false;
    };
  }, []);
  const confirm =
    drafts.requiresConfirmation(scope) || (!!error && drafts.dirty(scope));
  useEffect(() => {
    if (!pending && !saving && !confirm) finish(true);
  }, [pending, saving, confirm, finish]);
  // The toolbar shows Saving while the original page remains mounted.
  // Do not offer to discard a write that has already reached the server.
  if (pending || saving || !confirm) return null;
  return (
    <Modal title={t("unsavedChanges")} onClose={() => finish(false)}>
      {error && <p className="notice error">{error}</p>}
      <p>{t("leavePageHint")}</p>
      <footer>
        <button
          className="button secondary"
          autoFocus
          onClick={() => finish(false)}
        >
          {t("stayOnPage")}
        </button>
        <button
          className="button primary"
          onClick={() => {
            // Discard explicitly even if Back interrupts the route render.
            drafts.discard(scope);
            finish(true);
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
      // Project pages focus their heading rather than the shared tab bar.
      const target = document.querySelector<HTMLElement>(
        "h1, .flow-toolbar:not(.project-toolbar), .empty-state",
      );
      if (target) {
        target.tabIndex = -1;
        // Styles hide the focus ring of these noninteractive targets.
        target.dataset.routeFocus = "";
        target.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pathname, ready, loaded]);
  return null;
}
