import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
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
  type PathPart,
} from "./graph";
import HistoryPanel from "./HistoryPanel";
import { I18n, useT } from "./i18n";
import Inspector from "./Inspector";
import LineagePanel from "./LineagePanel";
import LoginPage from "./LoginPage";
import ModalHost, { type ModalState } from "./ModalHost";
import NodePalette, { type NodeKind } from "./NodePalette";
import { usePreferences, type Preferences } from "./preferences";
import Preview from "./Preview";
import ProjectDashboard from "./ProjectDashboard";
import UserSettings from "./UserSettings";
import { Toast, useToast } from "./Toast";
import TopBar, { type Area } from "./TopBar";
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

const WORKTREE_KEY = "duckpad-worktree";
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
  const [worktree, setWorktree] = useState(
    localStorage.getItem(WORKTREE_KEY) || "",
  );
  const currentWorktree = useRef(worktree);
  currentWorktree.current = worktree;
  const snapshotEpoch = useRef(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [environment, setEnvironment] = useState("dev");
  const [area, setArea] = useState<Area>(worktree ? "pipelines" : "projects");
  const [tab, setTab] = useState<WorkspaceTab>("flow");
  const [codeDirty, setCodeDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [path, setPath] = useState<PathPart[]>([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Statuses>(EMPTY_STATUSES);
  const [preview, setPreview] = useState<Json | null>(null);
  const [cell, setCell] = useState<Json | null>(null);
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
    if (!authenticated) return;
    refreshWorkspace()
      .then((value) => {
        if (!value.worktrees.some((w) => w.id === worktree)) {
          setWorktree("");
          localStorage.removeItem(WORKTREE_KEY);
          setArea("projects");
        }
      })
      .catch((e) => notify(e.message, true));
  }, [authenticated]);
  // Environments can be renamed in the settings; keep a configured one selected.
  const environments: string[] = workspace?.catalog.environments || [];
  useEffect(() => {
    if (environments.length && !environments.includes(environment))
      setEnvironment(environments[0]);
  }, [environments.join("|"), environment]);
  useEffect(() => {
    if (!worktree || !authenticated) return;
    localStorage.setItem(WORKTREE_KEY, worktree);
    setSnapshot(null);
    setSelected(null);
    setSelection([]);
    setPath([]);
    setCell(null);
    setPreview(null);
    setStatuses(EMPTY_STATUSES);
    load(worktree).catch((e) => notify(e.message, true));
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
            // request can return 404 while a renamed environment is refreshing.
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
              setWorktree("");
              setArea("pipelines");
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
      setWorkspace(null);
      setSnapshot(null);
      setStatuses({ nodes: {}, active: null });
      setModal(null);
      setCell(null);
      setPreview(null);
      setArea("pipelines");
      return;
    }
    const timer = setInterval(() => {
      refreshWorkspace()
        .then((value) => {
          if (
            value.user.role !== "admin" &&
            ["users", "connections"].includes(area)
          )
            setArea("pipelines");
        })
        .catch((e) => {
          if (e.status === 401) setAuthenticated(false);
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [authenticated, refreshWorkspace, area]);
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
    (p) => p.id === snapshot?.worktree.project,
  );

  const select = (id: string | null) => {
    setSelected(id);
    setCell(null);
    setPreview(null);
    if (id) {
      setInspectorOpen(true);
      setPreviewOpen(true);
      if (!window.matchMedia(WIDE_LAYOUT).matches) setPaletteOpen(false);
    }
  };
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
  ) {
    const created: FlowNode = {
      id: identifier(),
      ...(kind === "component" ? { component: id } : { template: id }),
      params: {},
      position,
    };
    await updateGraph((g) => g.nodes.push(created));
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
    if (!canEdit) return;
    setBusy(true);
    try {
      const result = await api(
        `/worktrees/${worktree}/runs`,
        send({ environment, node: target, entry_point: "ui" }),
      );
      setStatuses((old) => ({ ...old, active: result }));
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  function openProject(id: string) {
    setWorktree(id);
    setArea("pipelines");
    setTab("flow");
    setPath([]);
    setSelected(null);
    setSelection([]);
    setCell(null);
    setPreview(null);
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
      kind: "form",
      title: t("newProject"),
      fields: [{ key: "name", label: t("name") }],
      submit: async (v) => {
        const next = await api("/projects", send(v));
        await refreshWorkspace();
        openProject(next.id);
      },
    });
  }
  async function openExample() {
    setBusy(true);
    try {
      const result = await api("/example", send({}));
      await refreshWorkspace();
      openProject(result.id);
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
      duckdb: workspace?.catalog.duckdb_version,
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
          onArea={setArea}
          onHome={() => {
            setArea("projects");
            safe(refreshWorkspace);
          }}
          onHelp={() => safe(showAbout)}
          onOpenProject={openProject}
          onNewProject={newProject}
          onWorktree={setWorktree}
          onNewBranch={() => newBranch()}
          onGit={() => showGit("sync")}
          gitVersion={gitVersion}
          onEnvironment={(value) => {
            setEnvironment(value);
            setCell(null);
          }}
          onSignOut={() =>
            safe(async () => {
              await api("/logout", send({}));
              setAuthenticated(false);
            })
          }
        />
        {area === "projectSettings" && project && workspace ? (
          <ProjectSettings
            key={project.id}
            project={project.id}
            workspace={workspace}
            refresh={refreshWorkspace}
            onDeleted={() => {
              setSnapshot(null);
              setWorktree("");
              setArea("pipelines");
            }}
          />
        ) : area === "instanceSettings" && workspace && instanceAdmin ? (
          <InstanceSettings
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
            onIdentity={(identity) =>
              safe(async () => {
                await api("/identity", send(identity, "PUT"));
                await refreshWorkspace();
                notify(t("saved"));
              })
            }
            onEnvironments={(names) =>
              safe(async () => {
                await api("/environments", send(names, "PUT"));
                await refreshWorkspace();
                notify(t("saved"));
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
              onOpen={openProject}
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
              onProjectSettings={() => setArea("projectSettings")}
              tab={tab}
              saving={saving}
              dirty={codeDirty}
              branch={snapshot.worktree.branch}
              active={active}
              canRun={!busy && !!bundle}
              onTab={setTab}
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
              key={worktree}
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
                key={worktree}
                snapshot={snapshot}
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
                      statuses={statuses}
                      prefix={prefix}
                      viewKey={
                        worktree + ":" + path.map((p) => p.instance).join("/")
                      }
                      selected={selected}
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
                      onAdd={(kind, id, position) =>
                        safe(() => addNode(kind, id, position))
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
                        setCell(value);
                        setInspectorOpen(true);
                      }}
                      onData={setPreview}
                    />
                  ) : null}
                </main>
                <div
                  className="inspector-layer"
                  id="node-inspector"
                  hidden={!inspectorOpen}
                >
                  {cell ? (
                    <LineagePanel
                      key={worktree + environment}
                      worktree={worktree}
                      environment={environment}
                      cell={cell}
                      onClose={() => setCell(null)}
                    />
                  ) : node && definition ? (
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
                      onSave={async (updated, base) => {
                        await saveFrom(base, (value) => {
                          const target = graphAt(value, path);
                          target.nodes = target.nodes.map((n) =>
                            n.id === updated.id ? updated : n,
                          );
                        });
                      }}
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
      <Toast message={message} onDismiss={dismiss} />
      <ModalHost modal={modal} onClose={closeModal} />
    </div>
  );
}
