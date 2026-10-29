import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Link,
  useBlocker,
  useBeforeUnload,
  useLocation,
  useNavigate,
} from "react-router";
import {
  usePageRoute,
  worktreeUrl,
  isWorktreePage,
  signInReturn,
  SSO_RETURN_KEY,
} from "./navigation";
import { Modal } from "./modals";
import { AlertCircle, Loader2 } from "lucide-react";
import { api, ApiError, send, withQuery } from "./api";
import { ProjectSettings } from "./Administration";
import Canvas from "./Canvas";
import CanvasHeader from "./CanvasHeader";
import CodePanel from "./CodePanel";
import InstanceSettings from "./InstanceSettings";
import DocumentationPanel from "./DocumentationPanel";
import DuckMark from "./DuckMark";
import ErrorBoundary from "./ErrorBoundary";
import {
  FlowToolbar,
  WorkspaceNotices,
  noticeCount,
  type WorkspaceTab,
} from "./FlowToolbar";
import {
  connectInput,
  definitionOf,
  graphAt,
  identifier,
  outputPorts,
  pathPrefix,
  type NodeConnection,
  type PathPart,
} from "./graph";
import HistoryPanel from "./HistoryPanel";
import { I18n, useT } from "./i18n";
import Inspector from "./Inspector";
import LineagePanel from "./LineagePanel";
import type { Cell } from "./lineageGraph";
import LoginPage from "./LoginPage";
import ModalHost, { type ModalState } from "./ModalHost";
import NodePalette, { type NodeKind } from "./NodePalette";
import { usePreferences, type Preferences } from "./preferences";
import Preview from "./Preview";
import ProjectDashboard from "./ProjectDashboard";
import UserSettings from "./UserSettings";
import { Toast, useToast } from "./Toast";
import TopBar from "./TopBar";
import InstanceSearch from "./Search";
import { useSearchShortcut } from "./searchShortcuts";
import type {
  Bundle,
  FlowNode,
  Graph,
  Json,
  Snapshot,
  Statuses,
  Workspace,
} from "./types";
import { PanelResizeHandle, usePanelSizes } from "./WorkspacePanels";

const POLL_INTERVAL = 1000;
/** Height of each banner stacked under the toolbar, in pixels. */
const NOTICE_HEIGHT = 36;
const WIDE_LAYOUT = "(min-width: 1100px)";
const NEW_TEMPLATE = `-- @label Custom transform
-- @input source
-- @output result
SELECT * FROM {{ source }};
`;
const EMPTY_STATUSES: Statuses = { nodes: {}, active: null };

export default function App() {
  const preferences = usePreferences();
  return (
    <I18n.Provider
      value={{
        language: preferences.language,
        setLanguage: preferences.setLanguage,
      }}
    >
      <ErrorBoundary>
        <WorkspaceApp preferences={preferences} />
      </ErrorBoundary>
    </I18n.Provider>
  );
}

function WorkspaceApp({ preferences }: { preferences: Preferences }) {
  const t = useT();
  const { message, notify, dismiss } = useToast();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const route = usePageRoute();
  const { area } = route;
  const tab = route.tab || "flow";
  const location = useLocation();
  const navigate = useNavigate();
  const [signInDestination] = useState(() =>
    signInReturn(sessionStorage.getItem(SSO_RETURN_KEY)),
  );
  const [lastWorktree, setLastWorktree] = useState("");
  const worktree =
    route.worktreeId ||
    (area === "projectSettings"
      ? workspace?.projects.find((p) => p.id === route.projectId)?.main || ""
      : "");
  const environments: string[] = workspace?.catalog.environments || [];
  const requestedEnvironment = new URLSearchParams(location.search).get(
    "environment",
  );
  const environment =
    requestedEnvironment && environments.includes(requestedEnvironment)
      ? requestedEnvironment
      : environments[0] || "dev";
  const setWorktree = (id: string) => {
    void navigate(worktreeUrl(id, tab, environment));
  };
  const setTab = (value: WorkspaceTab) => {
    void navigate(worktreeUrl(worktree, value, environment));
  };
  const [loadError, setLoadError] = useState("");
  const currentWorktree = useRef(worktree);
  currentWorktree.current = worktree;
  const snapshotEpoch = useRef(0);
  const [snapshotState, setSnapshot] = useState<Snapshot | null>(null);
  const snapshot =
    snapshotState?.worktree.id === worktree ? snapshotState : null;
  const [codeDirty, setCodeDirty] = useState(false);
  const [documentationDirty, setDocumentationDirty] = useState(false);
  const [codeDraftVersion, setCodeDraftVersion] = useState(0);
  const [documentationDraftVersion, setDocumentationDraftVersion] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useSearchShortcut(authenticated && workspace ? "k" : undefined, openSearch);
  const handledSearch = useRef("");
  const [focusRequest, setFocusRequest] = useState<{
    id: string;
    key: string;
  } | null>(null);
  const expireSession = useCallback(() => setAuthenticated(false), []);
  const [path, setPath] = useState<PathPart[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Statuses>(EMPTY_STATUSES);
  const [preview, setPreview] = useState<Json | null>(null);
  const [cell, setCell] = useState<Cell | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [gitVersion, setGitVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(
    () => window.matchMedia(WIDE_LAYOUT).matches,
  );
  const [previewOpen, setPreviewOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const panels = usePanelSizes();
  const closeModal = useCallback(() => setModal(null), []);
  const updateSelection = useCallback(
    (ids: string[]) =>
      setSelection((previous) =>
        previous.join("|") === ids.join("|") ? previous : ids,
      ),
    [],
  );
  /** Run an action from an event handler, reporting failures in a toast. */
  const safe = (action: () => Promise<unknown>) => {
    void action().catch((e) => notify(e.message, true));
  };

  useEffect(() => {
    api("/session")
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false));
  }, []);
  const refreshWorkspace = useCallback(async () => {
    const value = await api<Workspace>("/workspace");
    setWorkspace(value);
    return value;
  }, []);
  const load = useCallback(
    async (id = worktree) => {
      if (!id) return;
      const epoch = snapshotEpoch.current;
      const value = await api<Snapshot>(`/worktrees/${id}`);
      // Discard reads started before a save completed or the worktree changed.
      if (id !== currentWorktree.current || epoch !== snapshotEpoch.current)
        return;
      setLoadError("");
      setSnapshot((old) =>
        old?.worktree.id === value.worktree.id &&
        old?.revision === value.revision &&
        old?.role === value.role &&
        JSON.stringify(old.connections) === JSON.stringify(value.connections) &&
        JSON.stringify(old.conflicts) === JSON.stringify(value.conflicts)
          ? old
          : value,
      );
    },
    [worktree],
  );
  useEffect(() => {
    if (authenticated)
      void refreshWorkspace().catch((e) => notify(e.message, true));
  }, [authenticated, refreshWorkspace, notify, location.key]);
  useEffect(() => {
    if (!authenticated || area !== "home") return;
    sessionStorage.removeItem(SSO_RETURN_KEY);
    void navigate(signInDestination || "/projects", { replace: true });
  }, [authenticated, area, navigate, signInDestination]);
  useEffect(() => {
    if (
      workspace &&
      area === "pipelines" &&
      requestedEnvironment &&
      !environments.includes(requestedEnvironment)
    ) {
      void navigate(worktreeUrl(worktree, tab, environment), { replace: true });
    }
  }, [
    workspace,
    area,
    worktree,
    tab,
    environment,
    requestedEnvironment,
    navigate,
  ]);
  useEffect(() => {
    setLoadError("");
    if (!worktree || !authenticated) return;
    setLastWorktree(worktree);
    setSnapshot(null);
    setSelected(null);
    setFocusRequest(null);
    handledSearch.current = "";
    setSelection([]);
    setPath([]);
    setCell(null);
    setPreview(null);
    setStatuses(EMPTY_STATUSES);
    load(worktree).catch((e) => {
      if (currentWorktree.current === worktree) {
        if (e.status === 401) setAuthenticated(false);
        else setLoadError(e.message);
      }
    });
  }, [worktree, authenticated]);
  useEffect(() => {
    if (!worktree || !authenticated) return;
    let live = true;
    let timer: number | undefined;
    // Each poll starts after the previous one ends, so responses never overlap.
    const poll = async () => {
      try {
        const [status] = await Promise.all([
          api<Statuses>(
            withQuery(`/worktrees/${worktree}/status`, { environment }),
          ),
          load(worktree).catch(async (e) => {
            // Only a denied snapshot means project access was revoked. A status
            // request can return 404 while a deleted environment is refreshing.
            if (
              live &&
              e instanceof ApiError &&
              [403, 404].includes(e.status)
            ) {
              setSnapshot(null);
              setCell(null);
              setPreview(null);
              setModal(null);
              setStatuses(EMPTY_STATUSES);
              setLoadError(t("routeUnavailable"));
              await refreshWorkspace();
            }
            throw e;
          }),
        ]);
        // Keep the previous object when nothing changed, so dependents do not refetch.
        if (live)
          setStatuses((old) =>
            JSON.stringify(old) === JSON.stringify(status) ? old : status,
          );
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiError && e.status === 401) setAuthenticated(false);
      }
      if (live) timer = window.setTimeout(poll, POLL_INTERVAL);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [worktree, environment, authenticated, load]);
  useEffect(() => {
    if (!authenticated) {
      setSearchOpen(false);
      setWorkspace(null);
      setSnapshot(null);
      setStatuses({ nodes: {}, active: null });
      setModal(null);
      setCell(null);
      setPreview(null);
      return;
    }
    const timer = setInterval(() => {
      refreshWorkspace().catch((e) => {
        if (e.status === 401) setAuthenticated(false);
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [authenticated, refreshWorkspace]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => {
    // Router history can advance before an unmounted editor's cleanup runs.
    // Only drafts belonging to the page being left may block a transition.
    if (!authenticated || !isWorktreePage(currentLocation.pathname, worktree))
      return false;
    const retainsCode = isWorktreePage(nextLocation.pathname, worktree);
    return (
      (codeDirty && !retainsCode) ||
      (documentationDirty &&
        currentLocation.pathname !== nextLocation.pathname) ||
      (saving && currentLocation.pathname !== nextLocation.pathname)
    );
  });
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (codeDirty || documentationDirty || saving) event.preventDefault();
      },
      [codeDirty, documentationDirty, saving],
    ),
  );
  useEffect(() => {
    setModal(null);
  }, [location.pathname]);
  const pageTitle = t(
    area === "pipelines"
      ? tab
      : area === "home"
        ? "projects"
        : area === "notFound"
          ? "routeNotFound"
          : area,
  );
  useEffect(() => {
    document.title = `${pageTitle} · Duckpad`;
  }, [pageTitle]);
  useEffect(() => {
    if (!authenticated || !workspace) return;
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
  }, [location.pathname, authenticated, !!workspace, !!snapshot]);
  const canEdit = snapshot?.role === "admin" || snapshot?.role === "editor";
  const instanceAdmin = workspace?.user.role === "admin";
  const bundle = snapshot?.bundle;
  const graph = bundle ? graphAt(bundle, path) : undefined;
  const prefix = pathPrefix(path);
  const node = graph?.nodes.find((n) => n.id === selected);
  const fullNode = prefix + (selected || "");
  const definition =
    node && snapshot ? definitionOf(node, snapshot) : undefined;
  const ports = node ? outputPorts(node, definition) : [];
  const active = statuses.active;
  const resultVersion = JSON.stringify(statuses.nodes);
  const project = workspace?.projects.find(
    (p) => p.id === (route.projectId || snapshot?.worktree.project),
  );

  const select = (id: string | null) => {
    setFocusRequest(null);
    setSelected(id);
    setCell(null);
    setPreview(null);
    if (id) {
      setInspectorOpen(true);
      setPreviewOpen(true);
      if (!window.matchMedia(WIDE_LAYOUT).matches) setPaletteOpen(false);
    }
  };
  useEffect(() => {
    if (!snapshot?.bundle || area !== "pipelines" || tab !== "flow") return;
    const target = new URLSearchParams(location.search).get("node");
    if (handledSearch.current === location.key) return;
    if (!target && !location.state?.searchResult) return;
    handledSearch.current = location.key;
    if (!target) {
      setPath([]);
      select(null);
      return;
    }
    const ids = target.split("::");
    const nextPath: PathPart[] = [];
    let graph: Graph = snapshot.bundle.flow;
    for (const instance of ids.slice(0, -1)) {
      const parent = graph.nodes.find((n) => n.id === instance);
      const definition =
        parent?.component && snapshot.bundle.components[parent.component];
      if (!parent?.component || !definition) {
        notify(t("searchTargetMissing"), true);
        return;
      }
      nextPath.push({
        instance,
        definition: parent.component,
        label: parent.label || definition.name || instance,
      });
      graph = definition as Graph;
    }
    const id = ids[ids.length - 1];
    if (!graph.nodes.some((node) => node.id === id)) {
      notify(t("searchTargetMissing"), true);
      return;
    }
    setPath(nextPath);
    select(id);
    setFocusRequest({ id, key: location.key });
  }, [
    snapshot,
    area,
    tab,
    location.key,
    location.search,
    location.state,
    notify,
    t,
  ]);
  async function saveBundle(value: Bundle, base = snapshot!) {
    if (!canEdit) throw new Error(t("readerNotice"));
    setSaving(true);
    try {
      const saved = await api<Snapshot>(
        `/worktrees/${base.worktree.id}`,
        send({ revision: base.revision, bundle: value }, "PUT"),
      );
      snapshotEpoch.current++;
      await load(base.worktree.id);
      return saved;
    } catch (e) {
      snapshotEpoch.current++;
      await load(base.worktree.id);
      notify((e as Error).message, true);
      throw e;
    } finally {
      setSaving(false);
    }
  }
  /** Save a change applied to a copy of the bundle of the given revision. */
  const saveFrom = (base: Snapshot, change: (value: Bundle) => void) => {
    const value = structuredClone(base.bundle!);
    change(value);
    return saveBundle(value, base);
  };
  async function updateGraph(change: (graph: Graph) => void) {
    if (!snapshot?.bundle || !canEdit) return;
    await saveFrom(snapshot, (value) => change(graphAt(value, path)));
  }
  async function addNode(
    kind: NodeKind,
    id: string,
    position = {
      x: 160 + ((graph?.nodes.length || 0) % 4) * 240,
      y: 120 + Math.floor((graph?.nodes.length || 0) / 4) * 210,
    },
    connection?: NodeConnection,
  ) {
    if (connection && !graph?.nodes.some((n) => n.id === connection.nodeId))
      return;
    const created: FlowNode = {
      id: identifier(),
      ...(kind === "component" ? { component: id } : { template: id }),
      params: {},
      position,
    };
    await updateGraph((g) => {
      g.nodes.push(created);
      if (connection)
        connectInput(
          g,
          connection.handleType === "source"
            ? {
                source: connection.nodeId,
                sourceHandle: connection.handleId,
                target: created.id,
                targetHandle: connection.port,
              }
            : {
                source: created.id,
                sourceHandle: connection.port,
                target: connection.nodeId,
                targetHandle: connection.handleId,
              },
        );
    });
    select(created.id);
  }
  async function removeNodes(ids: string[], edges: string[] = []) {
    await updateGraph((g) => {
      g.nodes = g.nodes.filter((n) => !ids.includes(n.id));
      g.edges = g.edges.filter(
        (e) =>
          !edges.includes(e.id) &&
          !ids.includes(e.source) &&
          !ids.includes(e.target),
      );
    });
    if (selected && ids.includes(selected)) select(null);
  }
  function openComponent(id: string) {
    const instance = graph?.nodes.find((n) => n.id === id);
    if (!instance?.component) return;
    setPath([
      ...path,
      {
        instance: id,
        definition: instance.component,
        label: instance.label || bundle!.components[instance.component].name,
      },
    ]);
    select(null);
  }
  async function run(target?: string) {
    if (!canEdit || busy) return;
    const launch = async (confirmed = false) => {
      setBusy(true);
      try {
        const result = await api(
          `/worktrees/${worktree}/runs`,
          send({ environment, node: target, entry_point: "ui", confirmed }),
        );
        if (currentWorktree.current === worktree)
          setStatuses((old) => ({ ...old, active: result }));
      } finally {
        setBusy(false);
      }
    };
    const confirm = (
      settings: Workspace["catalog"]["environment_details"][number],
    ) =>
      setModal({
        kind: "runConfirmation",
        environment: settings,
        target: `${snapshot?.bundle?.flow.name || ""} · ${snapshot?.worktree.branch || ""} · ${target || t("run")}`,
        submit: () => launch(true),
      });
    const settings = workspace?.catalog.environment_details.find(
      (item) => item.id === environment,
    );
    if (settings?.confirm_before_run) {
      confirm(settings);
      return;
    }
    try {
      await launch();
    } catch (e) {
      if (e instanceof ApiError && (e.detail as Json)?.confirmation_required) {
        confirm((e.detail as Json).confirmation_required);
        return;
      }
      notify((e as Error).message, true);
    }
  }
  function openProject(id: string) {
    void navigate(worktreeUrl(id, "flow", environment));
  }
  function newBranch(revision = "") {
    setModal({
      kind: "form",
      title: t("newBranch"),
      fields: [
        { key: "name", label: t("branchName"), value: "experiment/" },
        {
          key: "revision",
          label: t("fromRevision"),
          value: revision,
          required: false,
        },
      ],
      submit: async (v) => {
        const next = await api(
          `/worktrees/${worktree}/branches`,
          send({ name: v.name, revision: v.revision || undefined }),
        );
        await refreshWorkspace();
        setWorktree(next.id);
        notify(t("branchCreated"));
      },
    });
  }
  function newProject() {
    setModal({
      kind: "newProject",
      createEmpty: async (name) => {
        const next = await api("/projects", send({ name }));
        await refreshWorkspace();
        openProject(next.id);
      },
      createExample,
    });
  }
  async function createExample(name?: string) {
    const result = await api("/example", send({ name }));
    await refreshWorkspace();
    openProject(result.id);
  }
  async function openExample() {
    setBusy(true);
    try {
      await createExample();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  function editTemplate() {
    if (!node?.template || !snapshot) return;
    const base = snapshot;
    const id = node.template;
    setModal({
      kind: "editor",
      title: t("editTemplate"),
      readOnly: !canEdit,
      description: t("sharedTemplateHint"),
      value: base.bundle!.templates[id],
      save: async (text) => {
        await saveFrom(base, (value) => {
          value.templates[id] = text;
        });
      },
    });
  }
  function newTemplate(base: Snapshot) {
    const id = identifier("template");
    setModal({
      kind: "editor",
      title: t("newTemplate"),
      value: NEW_TEMPLATE,
      save: async (text) => {
        await saveFrom(base, (value) => {
          value.templates[id] = text;
        });
      },
    });
  }
  function editComponentDefinition(base: Snapshot) {
    const id = path[path.length - 1].definition;
    setModal({
      kind: "editor",
      language: "json",
      title: t("definition"),
      readOnly: !canEdit,
      value: JSON.stringify(base.bundle!.components[id], null, 2),
      description: t("sharedTemplateHint"),
      save: async (text) => {
        await saveFrom(base, (value) => {
          value.components[id] = JSON.parse(text);
        });
      },
    });
  }
  function groupSelection(base: Snapshot) {
    setModal({
      kind: "form",
      title: t("group"),
      fields: [
        { key: "name", label: t("groupName") },
        {
          key: "parameters",
          label: t("exposedParameters"),
          value: "{}",
          multiline: true,
          required: false,
        },
      ],
      description: t("exposedHint"),
      submit: async (values) => {
        const result = await api(
          `/worktrees/${worktree}/group`,
          send({
            revision: base.revision,
            nodes: selection,
            parent: path.at(-1)?.definition,
            name: values.name,
            parameters: JSON.parse(values.parameters || "{}"),
          }),
        );
        await load();
        select(result.selected);
      },
    });
  }
  async function saveFiles(files: Record<string, string>, base: Snapshot) {
    if (!canEdit) throw new Error(t("readerNotice"));
    setSaving(true);
    try {
      await api(
        `/worktrees/${base.worktree.id}`,
        send({ revision: base.revision, files }, "PUT"),
      );
    } finally {
      try {
        await load(base.worktree.id);
      } finally {
        setSaving(false);
      }
    }
  }
  function showGit(
    mode: "compare" | "branches" | "sync" = "compare",
    commit?: string,
    entity?: string,
  ) {
    if (!snapshot) return;
    setModal({
      kind: "git",
      worktree,
      role: snapshot.role,
      mode,
      commit,
      entity,
      onChanged: async () => {
        setGitVersion((value) => value + 1);
        await refreshWorkspace();
        await load();
      },
      onOpen: setWorktree,
    });
  }
  function resolveConflict(conflict: Json) {
    const resolve = async (body: Json) => {
      await api(`/conflicts/${conflict.id}/resolve`, send(body));
      await load();
    };
    setModal({
      kind: "conflict",
      conflict,
      choose: (choice) =>
        safe(async () => {
          await resolve({ choice });
          setModal(null);
        }),
      combine: () =>
        setModal({
          kind: "editor",
          title: t("combined"),
          language: "json",
          value: JSON.stringify(conflict.proposal, null, 2),
          save: (text) =>
            resolve({ choice: "combined", files: JSON.parse(text) }),
        }),
    });
  }
  async function openLibrary(base: Snapshot) {
    const items: Json[] = await api("/library");
    setModal({
      kind: "library",
      items: items.filter((item) => item.project !== base.worktree.project),
      importItem: (item) =>
        safe(async () => {
          await api(
            `/worktrees/${worktree}/import`,
            send({
              revision: base.revision,
              source_worktree: item.worktree,
              kind: item.kind,
              id: item.id,
            }),
          );
          await load();
          notify(t("importComplete"));
        }),
    });
  }
  async function showAbout() {
    const session = await api("/session");
    setModal({
      kind: "about",
      version: session.version,
      duckdb: workspace?.catalog.duckdb_version || "",
    });
  }
  async function showDiff(commit: string) {
    showGit("compare", commit);
  }

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
  const connections = (snapshot?.connections || []).filter(
    (connection) =>
      !["source", "export"].includes(definition?.kind) ||
      connection.capabilities.includes(
        definition?.kind === "export" ? "write" : "read",
      ),
  );
  const panelOpen = {
    palette: paletteOpen,
    inspector: inspectorOpen && !!node,
    preview: previewOpen && !!node && ports.length > 0,
  };
  return (
    <div className="app-shell">
      <div className="workspace-shell">
        <TopBar
          area={area}
          workspace={workspace}
          worktree={worktree}
          snapshot={snapshot}
          environment={environment}
          preferences={preferences}
          pipelineUrl={
            workspace?.worktrees.some((w) => w.id === lastWorktree)
              ? worktreeUrl(lastWorktree, "flow", environment)
              : "/projects"
          }
          onHelp={() => safe(showAbout)}
          onSearch={openSearch}
          onOpenProject={openProject}
          onNewProject={newProject}
          onWorktree={setWorktree}
          onNewBranch={() => newBranch()}
          onGit={() => showGit("sync")}
          gitVersion={gitVersion}
          onEnvironment={(value) => {
            void navigate(worktreeUrl(worktree, tab, value));
            setCell(null);
          }}
          onSignOut={() =>
            safe(async () => {
              await api("/logout", send({}));
              setAuthenticated(false);
            })
          }
        />
        {searchOpen && workspace && (
          <InstanceSearch
            workspace={workspace}
            environment={environment}
            onClose={() => setSearchOpen(false)}
            onExpired={expireSession}
          />
        )}
        {!workspace || area === "home" ? (
          <div className="startup" role="status" aria-label={t("loading")}>
            <Loader2 className="spin" />
          </div>
        ) : area === "notFound" ||
          (area === "instanceSettings" && !instanceAdmin) ||
          (area === "projectSettings" && !project) ||
          (area === "pipelines" &&
            (!workspace.worktrees.some((w) => w.id === worktree) ||
              loadError)) ? (
          <main className="empty-state" tabIndex={-1}>
            <AlertCircle size={32} />
            <h1>
              {t(area === "notFound" ? "routeNotFound" : "routeUnavailable")}
            </h1>
            <p>
              {t(
                area === "notFound"
                  ? "routeNotFoundHint"
                  : "routeUnavailableHint",
              )}
            </p>
            <Link className="button primary" to="/projects">
              {t("backToProjects")}
            </Link>
          </main>
        ) : area === "projectSettings" && project ? (
          <ProjectSettings
            key={project.id}
            project={project.id}
            workspace={workspace}
            refresh={refreshWorkspace}
            onDeleted={() => {
              setSnapshot(null);
              void navigate("/projects", { replace: true });
            }}
          />
        ) : area === "instanceSettings" && workspace && instanceAdmin ? (
          <InstanceSettings
            key={route.section}
            section={route.section!}
            workspace={workspace}
            refresh={async () => {
              await refreshWorkspace();
            }}
            onConnectorEditor={(data) =>
              setModal({
                kind: "editor",
                title: data.title,
                value: data.value,
                language: "json",
                save: async (text) => {
                  await api(
                    "/catalog/connector",
                    send(JSON.parse(text), "PUT"),
                  );
                  await refreshWorkspace();
                },
              })
            }
          />
        ) : area === "userSettings" && workspace ? (
          <UserSettings
            onPasswordChanged={() => setAuthenticated(false)}
            workspace={workspace}
            preferences={preferences}
          />
        ) : area === "projects" || !worktree ? (
          workspace ? (
            <ProjectDashboard
              projects={workspace.projects}
              busy={busy}
              onCreate={newProject}
              onExample={openExample}
            />
          ) : (
            <div className="startup" role="status" aria-label={t("loading")}>
              <Loader2 className="spin" />
            </div>
          )
        ) : !snapshot ? (
          <div className="startup">
            <Loader2 className="spin" />
          </div>
        ) : (
          <>
            <FlowToolbar
              readOnly={!canEdit}
              project={snapshot.worktree.project}
              worktree={worktree}
              environment={environment}
              tab={tab}
              saving={saving}
              dirty={codeDirty}
              branch={snapshot.worktree.branch}
              active={active}
              canRun={!busy && !!bundle}
              onMerge={() => showGit("branches")}
              onRun={() => run()}
              onStop={() =>
                safe(async () => {
                  const canceled = await api(
                    `/runs/${active!.id}/cancel`,
                    send({}),
                  );
                  setStatuses((old) => ({ ...old, active: canceled }));
                })
              }
            />
            <WorkspaceNotices
              snapshot={snapshot}
              active={active}
              onResolve={() => resolveConflict(snapshot.conflicts[0])}
              onViewFiles={() => setTab("code")}
            />
            <CodePanel
              key={`code:${worktree}:${codeDraftVersion}`}
              hidden={tab !== "code"}
              readOnly={!canEdit}
              snapshot={snapshot}
              onSave={saveFiles}
              onDirtyChange={setCodeDirty}
            />
            {tab === "code" ? null : tab === "history" ? (
              <HistoryPanel
                readOnly={!canEdit}
                worktree={worktree}
                onDiff={(commit) => safe(() => showDiff(commit))}
                onRevision={newBranch}
                onCompare={() => showGit()}
              />
            ) : tab === "documentation" && bundle ? (
              <DocumentationPanel
                readOnly={!canEdit}
                key={`documentation:${worktree}:${documentationDraftVersion}`}
                snapshot={snapshot}
                onDirtyChange={setDocumentationDirty}
                onSave={(text, base) =>
                  saveFrom(base, (value) => {
                    value.documentation.project = text;
                  })
                }
              />
            ) : bundle && graph ? (
              <div
                className={`flow-layout ${paletteOpen ? "palette-open" : ""} ${panelOpen.inspector ? "inspector-open" : ""} ${panelOpen.preview ? "preview-open" : ""} ${path.length ? "nested-flow" : ""}`}
                style={
                  {
                    "--notice-height": `${NOTICE_HEIGHT * noticeCount(snapshot, active)}px`,
                    "--palette-width": `${panels.sizes.palette}px`,
                    "--inspector-width": `${panels.sizes.inspector}px`,
                    "--preview-height": `${panels.sizes.preview}px`,
                  } as CSSProperties
                }
              >
                <NodePalette
                  readOnly={!canEdit}
                  snapshot={snapshot}
                  hidden={!paletteOpen}
                  onClose={() => setPaletteOpen(false)}
                  onAdd={(kind, id) => safe(() => addNode(kind, id))}
                  onNewTemplate={() => newTemplate(snapshot)}
                  onLibrary={() => safe(() => openLibrary(snapshot))}
                />
                <main className="canvas-column">
                  <CanvasHeader
                    projectName={project?.name || bundle.flow.name}
                    path={path}
                    hasNode={!!node}
                    paletteOpen={paletteOpen}
                    previewOpen={previewOpen}
                    inspectorOpen={inspectorOpen}
                    selectionCount={canEdit ? selection.length : 0}
                    onNavigate={(depth) => {
                      setPath(path.slice(0, depth));
                      select(null);
                    }}
                    onTogglePalette={() => setPaletteOpen(!paletteOpen)}
                    onTogglePreview={() => setPreviewOpen(!previewOpen)}
                    onToggleInspector={() => setInspectorOpen(!inspectorOpen)}
                    onGroup={() => groupSelection(snapshot)}
                    onEditDefinition={() => editComponentDefinition(snapshot)}
                  />
                  <div className="canvas">
                    <Canvas
                      readOnly={!canEdit}
                      nodes={graph.nodes}
                      edges={graph.edges}
                      parsed={snapshot.parsed_templates}
                      components={bundle.components}
                      excludedComponents={path.map((part) => part.definition)}
                      statuses={statuses}
                      prefix={prefix}
                      viewKey={
                        worktree + ":" + path.map((p) => p.instance).join("/")
                      }
                      selected={selected}
                      focusRequest={focusRequest}
                      onSelect={select}
                      onMove={(nodes) =>
                        updateGraph((g) => {
                          const positions = new Map(
                            nodes.map((n) => [n.id, n.position]),
                          );
                          g.nodes = g.nodes.map((n) => ({
                            ...n,
                            position: positions.get(n.id) ?? n.position,
                          }));
                        }).catch((error) => {
                          notify(error.message, true);
                          throw error;
                        })
                      }
                      onConnect={(connection) =>
                        safe(() =>
                          updateGraph((g) => connectInput(g, connection)),
                        )
                      }
                      onDelete={(nodes, edges) =>
                        safe(() => removeNodes(nodes, edges))
                      }
                      onAdd={(kind, id, position, connection) =>
                        safe(() => addNode(kind, id, position, connection))
                      }
                      onOpen={openComponent}
                      onSelection={updateSelection}
                    />
                  </div>
                  {node && ports.length > 0 ? (
                    <Preview
                      readOnly={!canEdit}
                      key={worktree + fullNode}
                      worktree={worktree}
                      environment={environment}
                      node={fullNode}
                      ports={ports}
                      version={resultVersion}
                      active={!!active}
                      hidden={!previewOpen}
                      onClose={() => setPreviewOpen(false)}
                      onRun={() => run(fullNode)}
                      onExplain={(value) => {
                        setCell({
                          dataset: value.dataset,
                          row: value.row,
                          column: value.column,
                        });
                      }}
                      onData={setPreview}
                    />
                  ) : null}
                </main>
                {cell && (
                  <LineagePanel
                    worktree={worktree}
                    environment={environment}
                    cell={cell}
                    onClose={() => setCell(null)}
                  />
                )}
                <div
                  className="inspector-layer"
                  id="node-inspector"
                  hidden={!inspectorOpen}
                >
                  {node && definition ? (
                    <Inspector
                      readOnly={!canEdit}
                      key={worktree + fullNode}
                      node={node}
                      definition={definition}
                      snapshot={snapshot}
                      graphNodes={graph.nodes}
                      graphEdges={graph.edges}
                      fullNode={fullNode}
                      environment={environment}
                      connections={connections}
                      statuses={statuses}
                      preview={preview}
                      onSave={(updated, base) =>
                        saveFrom(base, (value) => {
                          const target = graphAt(value, path);
                          target.nodes = target.nodes.map((n) =>
                            n.id === updated.id ? updated : n,
                          );
                        })
                      }
                      onSaveDocumentation={async (change, base) => {
                        await saveFrom(base, (value) =>
                          change(value.documentation),
                        );
                      }}
                      onInput={(port, source) =>
                        safe(() =>
                          updateGraph((g) => {
                            if (!source) {
                              g.edges = g.edges.filter(
                                (e) =>
                                  !(
                                    e.target === node.id &&
                                    e.targetHandle === port
                                  ),
                              );
                              return;
                            }
                            const [id, handle] = source.split(":");
                            connectInput(g, {
                              source: id,
                              sourceHandle: handle,
                              target: node.id,
                              targetHandle: port,
                            });
                          }),
                        )
                      }
                      onDelete={() => safe(() => removeNodes([node.id]))}
                      onRun={() => run(fullNode)}
                      onOpen={() => openComponent(node.id)}
                      onEditTemplate={editTemplate}
                      onHistory={() =>
                        showGit(
                          "compare",
                          undefined,
                          `${path.length ? `component/${path[path.length - 1].definition}/` : ""}node/${node.id}`,
                        )
                      }
                      onClose={() => setInspectorOpen(false)}
                    />
                  ) : null}
                </div>
                {(["palette", "inspector", "preview"] as const)
                  .filter((panel) => panelOpen[panel])
                  .map((panel) => (
                    <PanelResizeHandle
                      key={panel}
                      panel={panel}
                      value={panels.sizes[panel]}
                      limits={panels.limits[panel]}
                      onResize={(value) => panels.resize(panel, value)}
                      onReset={() => panels.reset(panel)}
                    />
                  ))}
              </div>
            ) : (
              <div className="empty-state">
                <AlertCircle size={32} />
                <h2>{t("invalid")}</h2>
                <p>{t("invalidHint")}</p>
                <button
                  className="button primary"
                  onClick={() => setTab("code")}
                >
                  {t("viewFiles")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {blocker.state === "blocked" && (
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
                if (!isWorktreePage(blocker.location.pathname, worktree)) {
                  setCodeDraftVersion((value) => value + 1);
                  setCodeDirty(false);
                }
                setDocumentationDraftVersion((value) => value + 1);
                setDocumentationDirty(false);
                blocker.proceed();
              }}
            >
              {t("leavePage")}
            </button>
          </footer>
        </Modal>
      )}
      <Toast message={message} onDismiss={dismiss} />
      <ModalHost modal={modal} onClose={closeModal} />
    </div>
  );
}
