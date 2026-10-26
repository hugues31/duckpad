import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BookOpen,
  Box,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  FileCode2,
  GitBranch,
  GitMerge,
  HelpCircle,
  Layers,
  Loader2,
  LogOut,
  Moon,
  Play,
  Plus,
  Search,
  Settings2,
  Square,
  Sun,
  Workflow,
  X,
} from "lucide-react";
import { I18n, useT, templateLabel, type Language } from "./i18n";
import {
  api,
  identifier,
  send,
  type Bundle,
  type FlowNode,
  type Json,
  type Snapshot,
  type Workspace,
} from "./types";
import Canvas, { nodeIcon } from "./Canvas";
import Preview from "./Preview";
import Inspector from "./Inspector";
import LineagePanel from "./LineagePanel";
import {
  ConnectionsPanel,
  DocumentationPanel,
  EditorModal,
  FileModal,
  FormModal,
  HistoryPanel,
  Modal,
} from "./Panels";

function DuckMark({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <rect width="40" height="40" rx="12" fill="#173d36" />
      <path
        d="M11 22c0-3 3-5 7-5h4v-4a5 5 0 1 1 10 0v8c0 7-6 10-12 10-6 0-10-3-10-8l1-1Z"
        fill="#e5ebbd"
      />
      <path d="m31 14 6 2-6 3" fill="#e4ad61" />
      <circle cx="28.5" cy="12.5" r="1.2" fill="#173d36" />
      <path
        d="M16 23c2 3 6 3 9 0"
        stroke="#173d36"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function App() {
  const [language, setLanguageState] = useState<Language>(() =>
    localStorage.getItem("duckpad-language") === "fr" ? "fr" : "en",
  );
  const setLanguage = (value: Language) => {
    localStorage.setItem("duckpad-language", value);
    setLanguageState(value);
    document.documentElement.lang = value;
  };
  const [theme, setThemeState] = useState(
    () => localStorage.getItem("duckpad-theme") || "light",
  );
  const setTheme = (value: string) => {
    localStorage.setItem("duckpad-theme", value);
    setThemeState(value);
  };
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = language;
  }, [theme, language]);
  return (
    <I18n.Provider value={{ language, setLanguage }}>
      <WorkspaceApp
        theme={theme}
        setTheme={setTheme}
        language={language}
        setLanguage={setLanguage}
      />
    </I18n.Provider>
  );
}

function WorkspaceApp({
  theme,
  setTheme,
  language,
  setLanguage,
}: {
  theme: string;
  setTheme: (v: string) => void;
  language: Language;
  setLanguage: (v: Language) => void;
}) {
  const t = useT();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [worktree, setWorktree] = useState(
    localStorage.getItem("duckpad-worktree") || "",
  );
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [environment, setEnvironment] = useState("dev");
  const [area, setArea] = useState("pipelines");
  const [tab, setTab] = useState("flow");
  const [selected, setSelected] = useState<string | null>(null);
  const [path, setPath] = useState<
    { instance: string; definition: string; label: string }[]
  >([]);
  const [selection, setSelection] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<Json>({ nodes: {}, active: null });
  const [preview, setPreview] = useState<Json | null>(null);
  const [cell, setCell] = useState<Json | null>(null);
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<Json | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    error?: boolean;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const useStableSelection = useCallback(
    (ids: string[]) =>
      setSelection((previous) =>
        previous.join("|") === ids.join("|") ? previous : ids,
      ),
    [],
  );
  const notify = useCallback(
    (message: string, error = false) => setToast({ message, error }),
    [],
  );
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 7000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
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
      const value = await api<Snapshot>(`/worktrees/${id}`);
      setSnapshot((old) =>
        old?.revision === value.revision &&
        JSON.stringify(old.conflicts) === JSON.stringify(value.conflicts)
          ? old
          : value,
      );
    },
    [worktree],
  );
  useEffect(() => {
    if (authenticated)
      refreshWorkspace()
        .then((value) => {
          if (!value.worktrees.some((w) => w.id === worktree))
            setWorktree(value.worktrees[0]?.id || "");
        })
        .catch((e) => notify(e.message, true));
  }, [authenticated]);
  useEffect(() => {
    if (worktree && authenticated) {
      localStorage.setItem("duckpad-worktree", worktree);
      setSnapshot(null);
      setSelected(null);
      setPath([]);
      setCell(null);
      setPreview(null);
      load(worktree).catch((e) => notify(e.message, true));
    }
  }, [worktree, authenticated]);
  useEffect(() => {
    if (!worktree || !authenticated) return;
    let live = true;
    const poll = async () => {
      try {
        const [status] = await Promise.all([
          api(`/worktrees/${worktree}/status?environment=${environment}`),
          load(worktree),
        ]);
        if (live) setStatuses(status);
      } catch (e) {
        if ((e as any).status === 401) setAuthenticated(false);
      }
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [worktree, environment, authenticated, load]);
  const bundle = snapshot?.bundle;
  const graph = path.length
    ? bundle?.components[path[path.length - 1].definition]
    : bundle?.flow;
  const prefix =
    path.map((p) => p.instance).join("::") + (path.length ? "::" : "");
  const node = graph?.nodes.find((n: FlowNode) => n.id === selected) as
    FlowNode | undefined;
  const fullNode = prefix + (selected || "");
  const definition = node?.component
    ? bundle?.components[node.component]
    : snapshot?.parsed_templates[node?.template || ""];
  const ports = node?.component
    ? Object.keys(definition?.outputs || {})
    : definition?.outputs || [];
  const active = statuses.active;
  const resultVersion = JSON.stringify(statuses.nodes);
  const project = workspace?.projects.find(
    (p) => p.id === snapshot?.worktree.project,
  );
  const select = (id: string | null) => {
    setSelected(id);
    setCell(null);
    setPreview(null);
  };
  async function saveBundle(value: Bundle, base = snapshot!) {
    setSaving(true);
    try {
      await api(
        `/worktrees/${base.worktree.id}`,
        send({ revision: base.revision, bundle: value }, "PUT"),
      );
      await load(base.worktree.id);
    } catch (e) {
      await load(base.worktree.id);
      notify((e as Error).message, true);
      throw e;
    } finally {
      setSaving(false);
    }
  }
  function mutateGraph(value: Bundle, change: (graph: Json) => void) {
    const graph = path.length
      ? value.components[path[path.length - 1].definition]
      : value.flow;
    change(graph);
  }
  async function updateGraph(change: (graph: Json) => void) {
    if (!bundle) return;
    const value = structuredClone(bundle);
    mutateGraph(value, change);
    await saveBundle(value);
  }
  async function addNode(
    kind: string,
    id: string,
    position = {
      x: 160 + ((graph?.nodes.length || 0) % 4) * 240,
      y: 120 + Math.floor((graph?.nodes.length || 0) / 4) * 210,
    },
  ) {
    const def =
      kind === "component"
        ? bundle?.components[id]
        : snapshot?.parsed_templates[id];
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
      g.nodes = g.nodes.filter((n: FlowNode) => !ids.includes(n.id));
      g.edges = g.edges.filter(
        (e: Json) =>
          !edges.includes(e.id) &&
          !ids.includes(e.source) &&
          !ids.includes(e.target),
      );
    });
    if (selected && ids.includes(selected)) select(null);
  }
  function openComponent(id: string) {
    const node = graph?.nodes.find((n: FlowNode) => n.id === id);
    if (node?.component) {
      setPath([
        ...path,
        {
          instance: id,
          definition: node.component,
          label: node.label || bundle!.components[node.component].name,
        },
      ]);
      select(null);
    }
  }
  async function run(target?: string) {
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
  const safe = (fn: () => Promise<unknown>) => {
    void fn().catch((e) => notify(e.message, true));
  };
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
      submit: async (v: Json) => {
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
  async function editTemplate() {
    if (!node?.template) return;
    const base = snapshot!;
    const id = node.template;
    setModal({
      kind: "editor",
      title: t("editTemplate"),
      description: t("sharedTemplateHint"),
      value: bundle!.templates[id],
      save: async (text: string) => {
        const value = structuredClone(base.bundle!);
        value.templates[id] = text;
        await saveBundle(value, base);
      },
    });
  }
  function projectForm() {
    setModal({
      kind: "form",
      title: t("newProject"),
      fields: [{ key: "name", label: t("name") }],
      submit: async (v: Json) => {
        const next = await api("/projects", send(v));
        await refreshWorkspace();
        setWorktree(next.id);
        setArea("pipelines");
      },
    });
  }
  async function example() {
    setBusy(true);
    try {
      const result = await api("/example", send({}));
      await refreshWorkspace();
      setWorktree(result.id);
      setArea("pipelines");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }
  async function compare() {
    const comparison = await api(`/worktrees/${worktree}/merge`);
    setModal({ kind: "merge", comparison });
  }
  const palette = useMemo(() => {
    if (!snapshot?.parsed_templates) return [];
    return Object.entries(snapshot.parsed_templates)
      .map(([id, d]) => ({
        id,
        kind: "template",
        label: templateLabel(id, d.label, t),
        category:
          d.kind === "source"
            ? "sources"
            : d.kind === "export"
              ? "exports"
              : "transforms",
        description: d.description,
      }))
      .concat(
        Object.entries(bundle?.components || {}).map(([id, d]) => ({
          id,
          kind: "component",
          label: d.name,
          category: "components",
          description: d.description,
        })),
      )
      .filter((item) =>
        item.label?.toLowerCase().includes(search.toLowerCase()),
      );
  }, [snapshot, bundle, search, t]);
  const themes = (
    <>
      <button
        className="icon"
        title={t(theme === "light" ? "dark" : "light")}
        onClick={() => setTheme(theme === "light" ? "dark" : "light")}
      >
        {theme === "light" ? <Moon size={17} /> : <Sun size={17} />}
      </button>
      <button
        className="language-button"
        title={t("language")}
        onClick={() => setLanguage(language === "en" ? "fr" : "en")}
      >
        {language.toUpperCase()}
      </button>
    </>
  );
  if (authenticated === null)
    return (
      <div className="startup">
        <DuckMark size={48} />
        <Loader2 className="spin" />
      </div>
    );
  if (!authenticated)
    return (
      <Login onSuccess={() => setAuthenticated(true)} preferences={themes} />
    );
  return (
    <div className="app-shell">
      <nav className="rail" aria-label={t("workspace")}>
        <button
          className="brand-button"
          title="Duckpad"
          onClick={() => setArea("pipelines")}
        >
          <DuckMark size={36} />
        </button>
        <div className="rail-main">
          {[
            ["pipelines", Workflow],
            ["connections", Database],
            ["settings", Settings2],
          ].map(([key, Icon]) => (
            <button
              key={key as string}
              className={`rail-button ${area === key ? "active" : ""}`}
              title={t(key as string)}
              aria-label={t(key as string)}
              onClick={() => setArea(key as string)}
            >
              <Icon size={21} />
            </button>
          ))}
        </div>
        <button
          className="rail-button"
          title={t("help")}
          onClick={() => setModal({ kind: "about" })}
        >
          <HelpCircle size={20} />
        </button>
        <button
          className="avatar"
          title={t("signOut")}
          onClick={() =>
            safe(async () => {
              await api("/logout", send({}));
              setAuthenticated(false);
            })
          }
        >
          A
        </button>
      </nav>
      <div className="workspace-shell">
        <header className="topbar">
          <div className="project-picker">
            <span className="project-symbol">
              <Layers size={18} />
            </span>
            <div>
              <span className="eyebrow">{t("workspace")}</span>
              <select
                aria-label={t("activeProject")}
                value={
                  snapshot?.worktree.project ||
                  workspace?.worktrees.find((w) => w.id === worktree)
                    ?.project ||
                  ""
                }
                onChange={(e) => {
                  const project = workspace?.projects.find(
                    (p) => p.id === e.target.value,
                  );
                  if (project) setWorktree(project.main);
                }}
              >
                {!workspace?.projects.length && <option>Duckpad</option>}
                {workspace?.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="icon"
              title={t("newProject")}
              onClick={projectForm}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="topbar-right">
            {snapshot && (
              <>
                <div className="branch-picker">
                  <GitBranch size={14} />
                  <select
                    aria-label={t("branch")}
                    value={worktree}
                    onChange={(e) => setWorktree(e.target.value)}
                  >
                    {workspace?.worktrees
                      .filter((w) => w.project === snapshot.worktree.project)
                      .map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.branch}
                        </option>
                      ))}
                  </select>
                  <button
                    className="icon"
                    title={t("newBranch")}
                    onClick={() => newBranch()}
                  >
                    <Plus size={13} />
                  </button>
                </div>
                <span className="header-divider" />
                <label className="environment-picker">
                  <span className={`env-dot ${environment}`} />
                  <select
                    aria-label={t("environment")}
                    value={environment}
                    onChange={(e) => {
                      setEnvironment(e.target.value);
                      setCell(null);
                    }}
                  >
                    {workspace?.catalog.environments.map((env: string) => (
                      <option key={env}>{env}</option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {themes}
          </div>
        </header>
        {area === "connections" && workspace ? (
          <ConnectionsPanel
            workspace={workspace}
            refresh={async () => {
              await refreshWorkspace();
            }}
            onEditor={(data) =>
              setModal({
                kind: "editor",
                title: data.title,
                value: data.value,
                language: "json",
                save: async (text: string) => {
                  await api(
                    "/catalog/connector",
                    send(JSON.parse(text), "PUT"),
                  );
                  await refreshWorkspace();
                },
              })
            }
          />
        ) : area === "settings" && workspace ? (
          <section className="full-panel settings-page">
            <span className="eyebrow">{t("workspace")}</span>
            <h1>{t("settings")}</h1>
            <div className="settings-card">
              <h2>{t("identity")}</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  safe(async () => {
                    await api(
                      "/identity",
                      send(
                        { name: data.get("name"), email: data.get("email") },
                        "PUT",
                      ),
                    );
                    await refreshWorkspace();
                    notify(t("saved"));
                  });
                }}
              >
                <label className="field">
                  <span>{t("authorName")}</span>
                  <input
                    name="name"
                    defaultValue={workspace.identity.name}
                    required
                  />
                </label>
                <label className="field">
                  <span>{t("authorEmail")}</span>
                  <input
                    name="email"
                    type="email"
                    defaultValue={workspace.identity.email}
                    required
                  />
                </label>
                <button className="button primary">{t("save")}</button>
              </form>
            </div>
            <div className="settings-card">
              <h2>{t("preferences")}</h2>
              <p className="muted">{t("localPreferences")}</p>
              <div className="row gap">{themes}</div>
            </div>
            <div className="settings-card">
              <h2>{t("environments")}</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  safe(async () => {
                    await api(
                      "/environments",
                      send(
                        String(data.get("environments"))
                          .split(",")
                          .map((e) => e.trim())
                          .filter(Boolean),
                        "PUT",
                      ),
                    );
                    await refreshWorkspace();
                    notify(t("saved"));
                  });
                }}
              >
                <label className="field">
                  <span>{t("environments")}</span>
                  <input
                    name="environments"
                    defaultValue={workspace.catalog.environments.join(", ")}
                  />
                </label>
                <button className="button secondary">{t("save")}</button>
              </form>
            </div>
          </section>
        ) : !worktree ? (
          <section className="welcome">
            <div className="welcome-art">
              <DuckMark size={76} />
              <span className="orbit one">
                <Database size={25} />
              </span>
              <span className="orbit two">
                <GitBranch size={25} />
              </span>
              <span className="orbit three">
                <Code2 size={25} />
              </span>
            </div>
            <span className="eyebrow">DUCKPAD / LOCAL DATA WORKSPACE</span>
            <h1>{t("welcome")}</h1>
            <p>{t("welcomeDescription")}</p>
            <div className="row gap">
              <button
                className="button primary large"
                onClick={example}
                disabled={busy}
              >
                {busy ? (
                  <Loader2 className="spin" size={17} />
                ) : (
                  <Play size={16} />
                )}{" "}
                {t("example")}
              </button>
              <button className="button secondary large" onClick={projectForm}>
                <Plus size={17} />
                {t("startBlank")}
              </button>
            </div>
            <div className="example-note">
              <Boxes size={20} />
              <span>{t("exampleDescription")}</span>
            </div>
          </section>
        ) : !snapshot ? (
          <div className="startup">
            <Loader2 className="spin" />
          </div>
        ) : (
          <>
            <div className="flow-toolbar">
              <div className="tabs main-tabs">
                {[
                  ["flow", Workflow],
                  ["documentation", BookOpen],
                  ["history", Activity],
                ].map(([key, Icon]) => (
                  <button
                    key={key as string}
                    className={tab === key ? "active" : ""}
                    onClick={() => setTab(key as string)}
                  >
                    <Icon size={15} />
                    {t(key as string)}
                  </button>
                ))}
              </div>
              <div className="row gap">
                <span className="save-status">
                  {saving ? (
                    <Loader2 size={13} className="spin" />
                  ) : (
                    <Check size={13} />
                  )}{" "}
                  {t(saving ? "saving" : "saved")}
                </span>
                <button
                  className="icon"
                  title={t("files")}
                  onClick={() => setModal({ kind: "files", base: snapshot })}
                >
                  <FileCode2 size={16} />
                </button>
                {snapshot.worktree.branch !== "main" && (
                  <button
                    className="button secondary small"
                    onClick={() => safe(compare)}
                  >
                    <GitMerge size={14} />
                    {t("merge")}
                  </button>
                )}
                {active ? (
                  <button
                    className="button stop"
                    title={t("cancelRunHint")}
                    onClick={() =>
                      safe(async () => {
                        const run = await api(
                          `/runs/${active.id}/cancel`,
                          send({}),
                        );
                        setStatuses({ ...statuses, active: run });
                      })
                    }
                    disabled={active.status === "canceling"}
                  >
                    <Square size={12} fill="currentColor" />
                    {t(active.status === "canceling" ? "canceling" : "stop")}
                  </button>
                ) : (
                  <button
                    className="button primary"
                    disabled={busy || !bundle}
                    onClick={() => run()}
                  >
                    <Play size={14} fill="currentColor" />
                    {t("run")}
                  </button>
                )}
              </div>
            </div>
            {!!snapshot.conflicts.length && (
              <div className="banner warning">
                <AlertCircle size={16} />
                <span>{t("conflictHint")}</span>
                <button
                  onClick={() =>
                    setModal({
                      kind: "conflict",
                      conflict: snapshot.conflicts[0],
                    })
                  }
                >
                  {t("resolve")}
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
            {!!snapshot.diagnostics.length && (
              <div className="banner error">
                <AlertCircle size={16} />
                <span>
                  {snapshot.diagnostics.length} ·{" "}
                  {snapshot.diagnostics[0].message}
                </span>
                <button
                  onClick={() => setModal({ kind: "files", base: snapshot })}
                >
                  {t("viewFiles")}
                  <ArrowRight size={14} />
                </button>
              </div>
            )}
            {active && (
              <div className="run-progress">
                <Loader2 className="spin" size={13} />
                <span>
                  {t(active.status)} · {active.environment} ·{" "}
                  {
                    Object.values(active.nodes || {}).filter(
                      (n: any) => n.status === "success",
                    ).length
                  }
                  /{Object.keys(active.nodes || {}).length} {t("nodes")}
                </span>
                <div className="progress-track">
                  <div
                    style={{
                      width: `${(100 * Object.values(active.nodes || {}).filter((n: any) => n.status === "success").length) / Math.max(1, Object.keys(active.nodes || {}).length)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {tab === "history" ? (
              <HistoryPanel
                worktree={worktree}
                onDiff={(commit) =>
                  safe(async () => {
                    const diff = await api(
                      `/worktrees/${worktree}/diff/${commit}`,
                    );
                    setModal({
                      kind: "editor",
                      title: t("diff"),
                      value: diff.diff,
                      language: "diff",
                      readOnly: true,
                    });
                  })
                }
                onRevision={newBranch}
              />
            ) : tab === "documentation" && bundle ? (
              <DocumentationPanel
                key={worktree}
                snapshot={snapshot}
                onSave={async (text, base) => {
                  const value = structuredClone(base.bundle!);
                  value.documentation.project = text;
                  await saveBundle(value, base);
                }}
              />
            ) : bundle && graph ? (
              <div className="flow-layout">
                <aside className="palette">
                  <div className="palette-title">
                    <span>{t("nodes")}</span>
                    <span className="counter">{palette.length}</span>
                  </div>
                  <div className="search">
                    <Search size={14} />
                    <input
                      placeholder={t("searchNodes")}
                      aria-label={t("searchNodes")}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <div className="palette-list">
                    {["sources", "transforms", "components", "exports"].map(
                      (category) => (
                        <section key={category}>
                          <h4>{t(category)}</h4>
                          {palette
                            .filter((p) => p.category === category)
                            .map((item) => {
                              const Icon = nodeIcon(
                                item.kind === "component"
                                  ? "component"
                                  : item.id,
                              );
                              return (
                                <button
                                  className="palette-item"
                                  key={item.id}
                                  draggable
                                  onDragStart={(e) => {
                                    e.dataTransfer.setData(
                                      "application/duckpad",
                                      JSON.stringify({
                                        kind: item.kind,
                                        id: item.id,
                                      }),
                                    );
                                    e.dataTransfer.effectAllowed = "move";
                                  }}
                                  onClick={() =>
                                    safe(() => addNode(item.kind, item.id))
                                  }
                                  title={item.description}
                                >
                                  <span
                                    className={`palette-icon ${item.category}`}
                                  >
                                    <Icon size={17} />
                                  </span>
                                  <span>{item.label}</span>
                                  <Plus size={12} className="palette-plus" />
                                </button>
                              );
                            })}
                        </section>
                      ),
                    )}
                  </div>
                  <div className="palette-bottom">
                    <button
                      className="text-button"
                      onClick={() => {
                        const id = identifier("template");
                        const base = snapshot;
                        setModal({
                          kind: "editor",
                          title: t("newTemplate"),
                          value:
                            "-- @label Custom transform\n-- @input source\n-- @output result\nSELECT * FROM {{ source }};\n",
                          save: async (text: string) => {
                            const value = structuredClone(base.bundle!);
                            value.templates[id] = text;
                            await saveBundle(value, base);
                          },
                        });
                      }}
                    >
                      <Code2 size={14} />
                      {t("newTemplate")}
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        safe(async () => {
                          const items = await api("/library");
                          setModal({ kind: "library", items });
                        })
                      }
                    >
                      <Boxes size={14} />
                      {t("library")}
                    </button>
                    <p>{t("dragHint")}</p>
                  </div>
                </aside>
                <main className="canvas-column">
                  <div className="canvas-breadcrumb">
                    <button
                      onClick={() => {
                        setPath([]);
                        select(null);
                      }}
                    >
                      <Workflow size={13} />
                      {project?.name || bundle.flow.name}
                    </button>
                    {path.map((part, index) => (
                      <span key={part.instance} className="row gap">
                        <ChevronRight size={12} />
                        <button
                          onClick={() => {
                            setPath(path.slice(0, index + 1));
                            select(null);
                          }}
                        >
                          {part.label}
                        </button>
                      </span>
                    ))}
                    <span className="spacer" />
                    {selection.length > 0 && (
                      <button
                        className="group-button"
                        onClick={() =>
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
                            submit: async (values: Json) => {
                              const result = await api(
                                `/worktrees/${worktree}/group`,
                                send({
                                  revision: snapshot.revision,
                                  nodes: selection,
                                  parent: path.at(-1)?.definition,
                                  name: values.name,
                                  parameters: JSON.parse(
                                    values.parameters || "{}",
                                  ),
                                }),
                              );
                              await load();
                              select(result.selected);
                            },
                          })
                        }
                      >
                        <Boxes size={13} />
                        {t("group")} ({selection.length})
                      </button>
                    )}
                  </div>
                  {path.length > 0 && (
                    <div className="component-notice">
                      {t("sharedComponentHint")}
                      <button
                        onClick={() => {
                          const base = snapshot;
                          const id = path[path.length - 1].definition;
                          setModal({
                            kind: "editor",
                            language: "json",
                            title: t("definition"),
                            value: JSON.stringify(
                              bundle.components[id],
                              null,
                              2,
                            ),
                            description: t("sharedTemplateHint"),
                            save: async (text: string) => {
                              const value = structuredClone(base.bundle!);
                              value.components[id] = JSON.parse(text);
                              await saveBundle(value, base);
                            },
                          });
                        }}
                      >
                        {t("definition")}
                      </button>
                    </div>
                  )}
                  <div className="canvas">
                    <Canvas
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
                        safe(() =>
                          updateGraph((g) => {
                            g.nodes = g.nodes.map(
                              (n: FlowNode) =>
                                nodes.find((m) => m.id === n.id) || n,
                            );
                          }),
                        )
                      }
                      onConnect={(connection) =>
                        safe(() =>
                          updateGraph((g) => {
                            g.edges = g.edges.filter(
                              (e: Json) =>
                                !(
                                  e.target === connection.target &&
                                  e.targetHandle === connection.targetHandle
                                ),
                            );
                            g.edges.push({
                              ...connection,
                              id: identifier("edge"),
                            });
                          }),
                        )
                      }
                      onDelete={(nodes, edges) =>
                        safe(() => removeNodes(nodes, edges))
                      }
                      onAdd={(kind, id, position) =>
                        safe(() => addNode(kind, id, position))
                      }
                      onOpen={openComponent}
                      onSelection={useStableSelection}
                    />
                  </div>
                  {node && ports.length > 0 ? (
                    <Preview
                      key={worktree + fullNode}
                      worktree={worktree}
                      environment={environment}
                      node={fullNode}
                      label={node.label || node.id}
                      ports={ports}
                      version={resultVersion}
                      active={!!active}
                      onRun={() => run(fullNode)}
                      onExplain={setCell}
                      onData={setPreview}
                      selectedCell={cell}
                    />
                  ) : (
                    <div className="canvas-footer">
                      <span>
                        <GitBranch size={13} />
                        {t("autoVersioned")}
                      </span>
                      <span>{t("selectionHint")}</span>
                    </div>
                  )}
                </main>
                {cell ? (
                  <LineagePanel
                    key={JSON.stringify([
                      worktree,
                      environment,
                      cell.dataset,
                      cell.row,
                      cell.column,
                    ])}
                    worktree={worktree}
                    environment={environment}
                    cell={cell}
                    onClose={() => setCell(null)}
                  />
                ) : node && definition ? (
                  <Inspector
                    key={worktree + fullNode}
                    node={node}
                    definition={definition}
                    snapshot={snapshot}
                    graphNodes={graph.nodes}
                    graphEdges={graph.edges}
                    fullNode={fullNode}
                    environment={environment}
                    connections={(workspace?.catalog.connections || []).filter(
                      (connection: Json) => {
                        if (!["source", "export"].includes(definition.kind))
                          return true;
                        const connector = workspace?.catalog.connectors.find(
                          (item: Json) => item.id === connection.connector,
                        );
                        return connector?.capabilities?.includes(
                          definition.kind === "export" ? "write" : "read",
                        );
                      },
                    )}
                    status={statuses}
                    preview={preview}
                    onSave={async (updated, base) => {
                      const value = structuredClone(base.bundle!);
                      mutateGraph(value, (g) => {
                        g.nodes = g.nodes.map((n: FlowNode) =>
                          n.id === updated.id ? updated : n,
                        );
                      });
                      await saveBundle(value, base);
                    }}
                    onInput={(port, source) =>
                      safe(() =>
                        updateGraph((g) => {
                          g.edges = g.edges.filter(
                            (e: Json) =>
                              !(
                                e.target === node.id && e.targetHandle === port
                              ),
                          );
                          if (source) {
                            const [id, handle] = source.split(":");
                            g.edges.push({
                              id: identifier("edge"),
                              source: id,
                              sourceHandle: handle,
                              target: node.id,
                              targetHandle: port,
                            });
                          }
                        }),
                      )
                    }
                    onDelete={() => safe(() => removeNodes([node.id]))}
                    onRun={() => run(fullNode)}
                    onOpen={() => openComponent(node.id)}
                    onEditTemplate={editTemplate}
                    onClose={() => select(null)}
                  />
                ) : (
                  <aside className="inspector empty-inspector">
                    <span className="empty-inspector-icon">
                      <Layers size={28} />
                    </span>
                    <h3>{t("nothingSelected")}</h3>
                    <p>{t("selectNode")}</p>
                    <div className="inspector-tip">
                      <GitBranch size={17} />
                      <span>{t("lineageHint")}</span>
                    </div>
                  </aside>
                )}
              </div>
            ) : (
              <div className="empty-state">
                <AlertCircle size={32} />
                <h2>{t("invalid")}</h2>
                <p>{t("invalidHint")}</p>
                <button
                  className="button primary"
                  onClick={() => setModal({ kind: "files", base: snapshot })}
                >
                  {t("viewFiles")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.error ? <AlertCircle size={17} /> : <Check size={17} />}
          <span>{toast.message}</span>
          <button className="icon" onClick={() => setToast(null)}>
            <X size={15} />
          </button>
        </div>
      )}
      {modal?.kind === "form" && (
        <FormModal
          title={modal.title}
          fields={modal.fields}
          description={modal.description}
          onSubmit={modal.submit}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "editor" && (
        <EditorModal
          title={modal.title}
          description={modal.description}
          value={modal.value}
          language={modal.language}
          readOnly={modal.readOnly}
          onSave={modal.save}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === "files" && (
        <FileModal
          snapshot={modal.base}
          onClose={() => setModal(null)}
          onSave={async (files) => {
            await api(
              `/worktrees/${worktree}`,
              send({ revision: modal.base.revision, files }, "PUT"),
            );
            await load();
          }}
        />
      )}
      {modal?.kind === "merge" && (
        <FileModal
          title={t("mergeReview")}
          description={
            t("mergeHint") +
            (modal.comparison.conflicts.length
              ? " · " + modal.comparison.conflicts.join(", ")
              : "")
          }
          snapshot={snapshot!}
          initialFiles={modal.comparison.files}
          onClose={() => setModal(null)}
          onSave={async (files) => {
            await api(
              `/worktrees/${worktree}/merge`,
              send({ ...modal.comparison, files }),
            );
            await refreshWorkspace();
            setWorktree(modal.comparison.target.id);
            notify(t("mergeComplete"));
          }}
        />
      )}
      {modal?.kind === "conflict" && (
        <Modal title={t("conflict")} onClose={() => setModal(null)} wide>
          <div className="modal-content">
            <p>{t("conflictHint")}</p>
            <pre className="expression">{modal.conflict.paths.join("\n")}</pre>
            <div className="conflict-comparison">
              <div>
                <h4>{t("keepCurrent")}</h4>
                <pre>{JSON.stringify(modal.conflict.current, null, 2)}</pre>
              </div>
              <div>
                <h4>{t("keepProposal")}</h4>
                <pre>{JSON.stringify(modal.conflict.proposal, null, 2)}</pre>
              </div>
            </div>
          </div>
          <footer>
            <button
              className="button secondary"
              onClick={() =>
                setModal({
                  kind: "editor",
                  title: t("combined"),
                  language: "json",
                  value: JSON.stringify(modal.conflict.proposal, null, 2),
                  save: async (text: string) => {
                    await api(
                      `/conflicts/${modal.conflict.id}/resolve`,
                      send({ choice: "combined", files: JSON.parse(text) }),
                    );
                    await load();
                  },
                })
              }
            >
              {t("combined")}
            </button>
            {["current", "proposal"].map((choice) => (
              <button
                key={choice}
                className={`button ${choice === "proposal" ? "primary" : "secondary"}`}
                onClick={() =>
                  safe(async () => {
                    await api(
                      `/conflicts/${modal.conflict.id}/resolve`,
                      send({ choice }),
                    );
                    setModal(null);
                    await load();
                  })
                }
              >
                {t(choice === "current" ? "keepCurrent" : "keepProposal")}
              </button>
            ))}
          </footer>
        </Modal>
      )}
      {modal?.kind === "library" && (
        <Modal title={t("library")} onClose={() => setModal(null)} wide>
          <div className="modal-content">
            <p className="muted">{t("importHint")}</p>
            {modal.items
              .filter(
                (item: Json) => item.project !== snapshot?.worktree.project,
              )
              .map((item: Json) => (
                <div
                  className="history-row"
                  key={item.project + item.kind + item.id}
                >
                  <Boxes size={18} />
                  <span className="grow">
                    <strong>{item.name}</strong>
                    <small>
                      {item.project_name} · {item.kind}
                    </small>
                  </span>
                  <button
                    className="button secondary small"
                    onClick={() =>
                      safe(async () => {
                        await api(
                          `/worktrees/${worktree}/import`,
                          send({
                            revision: snapshot!.revision,
                            source_worktree: item.worktree,
                            kind: item.kind,
                            id: item.id,
                          }),
                        );
                        await load();
                        notify(t("importComplete"));
                      })
                    }
                  >
                    {t("import")}
                  </button>
                </div>
              ))}
          </div>
        </Modal>
      )}
      {modal?.kind === "about" && (
        <Modal title="Duckpad" onClose={() => setModal(null)}>
          <div className="modal-content">
            <DuckMark size={48} />
            <p>{t("aboutText")}</p>
            <code>
              DuckDB {workspace?.catalog.duckdb_version} · Duckpad 0.1.0
            </code>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Login({
  onSuccess,
  preferences,
}: {
  onSuccess: () => void;
  preferences: React.ReactNode;
}) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <div className="login-page">
      <div className="login-preferences">{preferences}</div>
      <div className="login-brand">
        <DuckMark size={42} />
        <span>duckpad</span>
      </div>
      <section className="login-card">
        <span className="eyebrow">LOCAL DATA WORKSPACE</span>
        <h1>{t("signIn")}</h1>
        <p>{t("loginDescription")}</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setPending(true);
            setError("");
            try {
              await api("/login", send({ username: "admin", password }));
              onSuccess();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setPending(false);
            }
          }}
        >
          <label className="field">
            <span>{t("username")}</span>
            <input value="admin" readOnly autoComplete="username" />
          </label>
          <label className="field">
            <span>{t("password")}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              autoComplete="current-password"
            />
          </label>
          {error && <div className="notice error">{error}</div>}
          <button className="button primary full large" disabled={pending}>
            {pending ? (
              <Loader2 size={17} className="spin" />
            ) : (
              <ArrowRight size={17} />
            )}{" "}
            {t("signInAction")}
          </button>
        </form>
        <p className="login-hint">{t("passwordHint")}</p>
      </section>
      <div className="login-footnote">
        <Database size={14} />
        <span>DuckDB + SQL + lineage</span>
      </div>
    </div>
  );
}
