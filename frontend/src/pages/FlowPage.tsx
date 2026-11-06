import type { ActionItem } from "../ActionMenu";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useLocation, useOutletContext } from "react-router";
import { Loader2 } from "lucide-react";
import Canvas, { type CanvasHandle, type FocusRequest } from "../Canvas";
import { findNodePosition } from "../graphLayout";
import CanvasHeader from "../CanvasHeader";
import BranchResultsNotice from "../BranchResultsNotice";
import { noticeCount } from "../FlowToolbar";
import {
  connectInput,
  graphAt,
  identifier,
  nodeInterface,
  pathPrefix,
  type NodeConnection,
  type PathPart,
} from "../graph";
import Inspector from "../Inspector";
import NodeCodePanel, { type CodeReveal } from "../NodeCodePanel";
import {
  DEFAULT_SAMPLE,
  type DraftPreview,
  type MissingInput,
  type PreviewState,
  type SampleSize,
} from "../draftPreview";
import {
  copiedNodes,
  copyNodes,
  pastableNodes,
  pasteNodes,
  type CopiedNodes,
} from "../nodeClipboard";
import { blockingDialogShown, typingTarget } from "../searchShortcuts";
import {
  detachNode,
  freshNodeCode,
  localDefinitions,
  nodeCode,
  nodeCodePath,
  nodeLocation,
  nodeEntity,
  nodeGraph,
  templateUsage,
} from "../nodeCode";
import LineagePanel from "../LineagePanel";
import type { Cell } from "../lineageGraph";
import NodePalette, { type NodeKind } from "../NodePalette";
import ResultsPanel, { type ResultsTab } from "../ResultsPanel";
import { api, errorDetail, send } from "../api";
import { useShell, useWorkspace } from "../shell";
import type {
  Bundle,
  FlowNode,
  Graph,
  Snapshot,
  SqlDiagnostic,
} from "../types";
import { countLabel, isBuiltinTemplate, nodeLabel, useT } from "../i18n";
import {
  isWideLayout,
  PanelResizeHandles,
  usePanelSizes,
} from "../WorkspacePanels";
import { declarations } from "../variables";
import { useLoadedWorktree } from "../worktree";
import { InvalidProject } from "./PageStates";

/** Height of each banner stacked under the toolbar, in pixels. */
const NOTICE_HEIGHT = 36;
/** A Filter node's code when the project has no `filter` template to copy. */
const FILTER_SQL =
  "-- @label Filter\n-- @input source\n-- @param condition: expression(source)\n-- @output result\nSELECT * FROM {{ source }} WHERE {{ condition }};\n";

interface FlowLocation {
  worktree: string;
  environment: string;
  path: PathPart[];
  selected: string | null;
  /** The history entry whose `node` parameter was revealed last. */
  revealed: string;
  /** The result cell whose lineage is explained. */
  cell: Cell | null;
  /** Whether the code of the selected node replaces the inspector. */
  code: boolean;
}

/**
 * The opened component, selected node and explained cell of the flow tab.
 * WorktreePage keeps them while other tabs are shown. They reset when another
 * working branch opens, and the explanation when the environment changes.
 */
export function useFlowView(worktree: string, environment: string) {
  const empty: FlowLocation = {
    worktree,
    environment,
    path: [],
    selected: null,
    revealed: "",
    cell: null,
    code: false,
  };
  const [view, setView] = useState(empty);
  if (view.worktree !== worktree) setView(empty);
  else if (view.environment !== environment)
    setView({ ...view, environment, cell: null });
  return {
    ...view,
    change: (update: Partial<FlowLocation>) =>
      setView((current) => ({ ...current, ...update })),
  };
}
type FlowView = ReturnType<typeof useFlowView>;

/** Find the node named by a search result, inside the components it lies in. */
function locate(bundle: Bundle, target: string) {
  const ids = target.split("::");
  const path: PathPart[] = [];
  let graph: Graph = bundle.flow;
  for (const instance of ids.slice(0, -1)) {
    const parent = graph.nodes.find((n) => n.id === instance);
    const definition = parent?.component && bundle.components[parent.component];
    if (!parent?.component || !definition) return null;
    path.push({
      instance,
      definition: parent.component,
      label: parent.label || definition.name || instance,
    });
    graph = definition;
  }
  const id = ids[ids.length - 1];
  return graph.nodes.some((node) => node.id === id) ? { path, id } : null;
}

export default function FlowPage() {
  const t = useT();
  const { notify, openModal, flowPanels: panels, drafts } = useShell();
  const workspace = useWorkspace();
  const {
    id: worktree,
    environment,
    snapshot,
    statuses,
    runDiagnostics,
    canEdit,
    saving,
    settle,
    save,
    run,
    undo,
    redo,
  } = useLoadedWorktree();
  const view = useOutletContext<FlowView>();
  const { path, selected, cell } = view;
  const location = useLocation();
  const sizes = usePanelSizes();
  const canvas = useRef<CanvasHandle>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [addingNode, setAddingNode] = useState(false);
  const additionPending = useRef(false);
  // Undos and redos in flight; editors stay inert so no edit races them.
  const [reverting, setReverting] = useState(0);
  const busy = addingNode || reverting > 0;
  const [resultsTab, setResultsTab] = useState<ResultsTab>("data");
  const [failureFocus, setFailureFocus] = useState(0);
  // Badges and summary links open their results tab, even when the panel is hidden.
  const showResults = (tab: ResultsTab) => {
    setResultsTab(tab);
    panels.set({ preview: true });
  };
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  // The preview of the selected node, computed from samples of its inputs.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [sample, setSample] = useState<SampleSize>(DEFAULT_SAMPLE);
  const [codeReveal, setCodeReveal] = useState<CodeReveal | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  // The code being edited in the code panel, which previews compute.
  const codeDraft = useRef<{ node: string; code: string } | null>(null);
  // The node to preview again once the run of its ancestors, when it starts, ends.
  const previewAfterRun = useRef<{ node: string; run: string | null } | null>(
    null,
  );
  const bundle = snapshot.bundle;
  const declared = snapshot.variables?.declarations;
  const valueProducers = useMemo(
    () =>
      Object.values(declared || {}).flatMap((v) =>
        v.from ? [v.from.node] : [],
      ),
    [declared],
  );
  const graph = bundle ? graphAt(bundle, path) : undefined;
  const prefix = pathPrefix(path);
  const parent = path.at(-1)?.definition;
  const local = localDefinitions(snapshot, parent);
  const node = graph?.nodes.find((n) => n.id === selected);
  const fullNode = prefix + (selected || "");
  const signature = node
    ? nodeInterface(node, snapshot.parsed_templates, bundle?.components, local)
    : undefined;
  const definition = signature?.definition;
  const ports = signature?.outputs || [];
  const project = workspace.projects.find(
    (p) => p.id === snapshot.worktree.project,
  );
  // The Inspector saves its draft when it closes, and can no longer show
  // the error of that save; report it instead.
  const inspected = worktree + fullNode;
  const shownInspector = useRef("");
  const inspectorShown =
    node && definition && panels.open.inspector ? inspected : "";
  useLayoutEffect(() => {
    shownInspector.current = inspectorShown;
    return () => {
      shownInspector.current = "";
    };
  }, [inspectorShown]);
  const fromInspector = <T,>(key: string, saving: Promise<T>) =>
    saving.catch((error) => {
      if (shownInspector.current !== key) notify(error.message, true);
      throw error;
    });
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
  /** Report a failure, then let the caller react to it too. */
  const reported = (action: Promise<void>) =>
    action.catch((error) => {
      notify(error.message, true);
      throw error;
    });

  const select = (
    id: string | null,
    nextPath?: PathPart[],
    revealed?: string,
  ) => {
    setFocusRequest(null);
    if (prefix + (id || "") !== fullNode || nextPath) {
      // A preview belongs to the node it computed.
      previewRequest.current?.abort();
      previewAfterRun.current = null;
      setPreview(null);
      setCodeReveal(null);
      if (resultsTab === "preview") setResultsTab("data");
    }
    view.change({
      selected: id,
      cell: null,
      ...(nextPath ? { path: nextPath } : {}),
      ...(revealed ? { revealed } : {}),
    });
    if (id)
      panels.set({
        inspector: true,
        preview: true,
        ...(isWideLayout() ? {} : { palette: false }),
      });
  };
  const reveal = useEffectEvent(
    (found: { path: PathPart[]; id: string | null } | null) => {
      if (!found) {
        notify(t("searchTargetMissing"), true);
        view.change({ revealed: location.key });
        return;
      }
      select(found.id, found.path, location.key);
      if (location.state?.valueSource)
        view.change({ cell: location.state.valueSource as Cell });
      if (found.id) setFocusRequest({ id: found.id, key: location.key });
    },
  );
  // Reveal the node named by a search result, once per navigation.
  useEffect(() => {
    if (!bundle || view.revealed === location.key) return;
    const target = new URLSearchParams(location.search).get("node");
    if (!target && !location.state?.searchResult) return;
    // A navigation, not a user event on this page, names the node to select.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- once per location key
    reveal(target ? locate(bundle, target) : { path: [], id: null });
  }, [bundle, view.revealed, location.key, location.search, location.state]);

  /** Compute the selected node's code, or its draft, on samples of its inputs. */
  async function requestPreview(code?: string, rows: SampleSize = sample) {
    if (!node || !canEdit) return;
    const target = fullNode;
    const draft =
      code ??
      (codeDraft.current?.node === target ? codeDraft.current.code : undefined);
    previewRequest.current?.abort();
    const request = new AbortController();
    previewRequest.current = request;
    // The previous rows stay visible, dimmed, until the new ones arrive.
    setPreview((current) => ({
      node: target,
      environment,
      pending: true,
      result: current?.node === target ? current.result : undefined,
    }));
    showResults("preview");
    try {
      const result = await api<DraftPreview>(
        `/worktrees/${worktree}/draft-preview/${encodeURIComponent(target)}`,
        {
          ...send({ environment, code: draft, rows }),
          signal: request.signal,
        },
      );
      if (request.signal.aborted) return;
      setPreview({ node: target, environment, pending: false, result });
    } catch (error) {
      if (request.signal.aborted) return;
      const detail = errorDetail(error);
      setPreview({
        node: target,
        environment,
        pending: false,
        error: t(
          detail.code === "run_active"
            ? "previewRunActive"
            : detail.code === "python_preview"
              ? "previewPython"
              : detail.code === "partitioned_preview"
                ? "previewPartitioned"
                : "previewFailed",
        ).replace("{message}", (error as Error).message),
        missing: detail.missing as MissingInput[] | undefined,
        diagnostic: detail.diagnostic as SqlDiagnostic | undefined,
      });
    }
  }
  const previewAgain = useEffectEvent((active: string | null) => {
    const waiting = previewAfterRun.current;
    if (waiting?.node !== fullNode) return;
    // The run of these ancestors, once it starts; a run that fails to start leaves none.
    if (active) {
      if (statuses.active?.ancestors && statuses.active.scope === waiting.node)
        waiting.run ??= active;
    } else if (waiting.run) {
      previewAfterRun.current = null;
      void requestPreview();
    }
  });
  // Once the ancestors have run, preview again what they were computed for.
  const activeRun = statuses.active?.id ?? null;
  useEffect(() => previewAgain(activeRun), [activeRun]);
  const runAncestors = () => {
    previewAfterRun.current = { node: fullNode, run: null };
    void run(fullNode, { ancestors: true });
  };

  async function updateGraph(change: (graph: Graph) => void) {
    if (!canEdit) return;
    await save(snapshot, (value) => change(graphAt(value, path)));
  }
  /**
   * Save new nodes, then select the one `change` returns. Editors stay inert
   * meanwhile, so an edit cannot land on the node the inspector still shows.
   */
  async function insertNode(change: (value: Bundle) => string) {
    if (!canEdit || additionPending.current) return false;
    additionPending.current = true;
    setAddingNode(true);
    try {
      let id = "";
      await save(snapshot, (value) => {
        id = change(value);
      });
      select(id);
      return true;
    } finally {
      additionPending.current = false;
      setAddingNode(false);
    }
  }
  async function addNode(
    kind: NodeKind,
    id: string,
    position?: FlowNode["position"],
    connection?: NodeConnection,
    linked = false,
  ) {
    if (connection && !graph?.nodes.some((n) => n.id === connection.nodeId))
      return;
    const created: FlowNode = {
      id: identifier(),
      // SQL is the default: flow.json names the language of Python nodes only.
      ...(id.endsWith(".py") && { language: "python" as const }),
      ...(kind === "component" ? { component: id } : { template: id }),
      params: {},
      position:
        position ??
        canvas.current?.newNodePosition(graph?.nodes || []) ??
        findNodePosition(graph?.nodes || []),
    };
    const added = await insertNode((value) => {
      const g = graphAt(value, path);
      if (kind === "template" && !linked) {
        detachNode(value, created, parent);
        freshNodeCode(value, created, parent);
      }
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
      return created.id;
    });
    if (added && !position)
      setFocusRequest({ id: created.id, key: created.id, reveal: true });
  }
  async function removeNodes(ids: string[], edges: string[] = []) {
    const { change } = await save(snapshot, (value) => {
      const g = graphAt(value, path);
      g.nodes
        .filter((node) => ids.includes(node.id))
        .forEach(
          (node) =>
            delete value.node_sql?.[
              nodeCodePath(node.id, parent, node.language)
            ],
        );
      g.nodes = g.nodes.filter((n) => !ids.includes(n.id));
      g.edges = g.edges.filter(
        (e) =>
          !edges.includes(e.id) &&
          !ids.includes(e.source) &&
          !ids.includes(e.target),
      );
    });
    if (selected && ids.includes(selected)) select(null);
    if (change && ids.length)
      notify(
        ids.length === 1
          ? t("nodeDeleted")
          : t("nodesDeleted").replace("{count}", String(ids.length)),
        false,
        { label: t("undo"), run: () => revert("undo", change) },
      );
  }
  /** Undo or redo a change, from a shortcut or a toast, and report it. */
  function revert(direction: "undo" | "redo", change?: string) {
    setReverting((count) => count + 1);
    safe(async () => {
      try {
        const done = await (direction === "undo" ? undo(change) : redo());
        notify(
          t(
            direction === "undo"
              ? done
                ? "changeUndone"
                : "nothingToUndo"
              : done
                ? "changeRedone"
                : "nothingToRedo",
          ),
        );
      } finally {
        setReverting((count) => count - 1);
      }
    });
  }
  /** Copy nodes of the opened graph, with the edits still being saved. */
  async function copy(ids: string[]) {
    let source = bundle!;
    if (canEdit && (saving || drafts.dirty())) {
      await settle();
      source = (await api<Snapshot>(`/worktrees/${worktree}`)).bundle!;
    }
    const copied = copyNodes(source, parent, ids);
    if (copied)
      notify(
        copied.nodes.length === 1
          ? t("nodeCopied")
          : t("nodesCopied").replace("{count}", String(copied.nodes.length)),
      );
  }
  /** Paste the copied nodes into the opened graph and select the first one. */
  async function paste(copied: CopiedNodes) {
    const opened = path.map((part) => part.definition);
    if (!pastableNodes(bundle!, copied, opened).length) {
      notify(t("nothingPasted"), true);
      return;
    }
    let ids: string[] = [];
    const added = await insertNode((value) => {
      ids = pasteNodes(value, parent, copied, opened);
      return ids[0];
    });
    if (added) setFocusRequest({ id: ids[0], key: ids[0], reveal: true });
  }
  // Undo, redo, copy and paste yield to typing and to blocking dialogs.
  const shortcut = useEffectEvent((event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.altKey ||
      !(event.ctrlKey || event.metaKey) ||
      typingTarget(event.target) ||
      blockingDialogShown()
    )
      return;
    const key = event.key.toLowerCase();
    if (key === "z" || key === "y") {
      // Repeated undos queue up behind the one in flight.
      if (!canEdit || addingNode || !bundle) return;
      event.preventDefault();
      if (!event.repeat)
        revert(key === "y" || event.shiftKey ? "redo" : "undo");
    } else if (key === "c" && !event.shiftKey && graph) {
      // Selected text is copied as usual.
      if (window.getSelection()?.toString()) return;
      const ids = selection.length ? selection : selected ? [selected] : [];
      if (!graph.nodes.some((item) => ids.includes(item.id))) return;
      event.preventDefault();
      if (!event.repeat) safe(() => copy(ids));
    } else if (key === "v" && !event.shiftKey) {
      const copied = copiedNodes();
      if (!canEdit || busy || !bundle || !copied) return;
      event.preventDefault();
      if (!event.repeat) safe(() => paste(copied));
    }
  });
  useEffect(() => {
    document.addEventListener("keydown", shortcut);
    return () => document.removeEventListener("keydown", shortcut);
  }, []);
  /** Insert a Filter node reading one output of the selected node, with a sample's condition. */
  async function addFilterNode(port: string, condition: string) {
    if (!node) return;
    const created: FlowNode = {
      id: identifier(),
      params: { condition },
      position: { x: node.position.x + 240, y: node.position.y + 140 },
    };
    const filter = snapshot.parsed_templates.filter;
    const reusable =
      bundle?.templates.filter !== undefined &&
      filter?.inputs?.length === 1 &&
      filter.parameters?.some((p) => p.name === "condition");
    const added = await insertNode((value) => {
      const g = graphAt(value, path);
      if (reusable) {
        created.template = "filter";
        detachNode(value, created, parent);
        freshNodeCode(value, created, parent);
      } else {
        created.preset = "filter";
        (value.node_sql ||= {})[nodeCodePath(created.id, parent)] = FILTER_SQL;
      }
      g.nodes.push(created);
      connectInput(g, {
        source: node.id,
        sourceHandle: port,
        target: created.id,
        targetHandle: reusable ? filter!.inputs![0] : "source",
      });
      return created.id;
    });
    if (added) notify(t("filterNodeAdded"));
  }
  function openComponent(id: string) {
    const instance = graph?.nodes.find((n) => n.id === id);
    if (!instance?.component) return;
    select(null, [
      ...path,
      {
        instance: id,
        definition: instance.component,
        label:
          instance.label || bundle!.components[instance.component].name || id,
      },
    ]);
  }

  if (!bundle || !graph) return <InvalidProject />;
  const connections = snapshot.connections.filter(
    (connection) =>
      (signature?.kind !== "source" && signature?.kind !== "export") ||
      connection.capabilities.includes(
        signature.kind === "export" ? "write" : "read",
      ),
  );
  // Component instances have no code: they keep the inspector.
  const hasCode = !!node && !node.component;
  const codeShown = view.code && hasCode && !!definition;
  const shown = {
    palette: panels.open.palette,
    inspector: panels.open.inspector && !!node && !codeShown,
    preview: panels.open.preview && !!node,
    code: panels.open.inspector && codeShown,
  };
  const editCode = (line?: number, target = fullNode) => {
    // The code of a node of this graph docks beside the canvas, in the inspector's place.
    const shown = graph.nodes.find((item) => prefix + item.id === target);
    if (shown && !shown.component) {
      if (shown.id !== selected) select(shown.id);
      view.change({ code: true });
      panels.set({ inspector: true });
      // A new key reveals the line again, even when the panel already shows it.
      if (line)
        setCodeReveal((current) => ({ line, key: (current?.key ?? 0) + 1 }));
      return;
    }
    const location = nodeLocation(bundle, target);
    if (!location) return;
    const { node, parent } = location;
    openModal(
      node.template
        ? {
            kind: "template",
            worktree,
            template: node.template,
            fullNode: target,
            line,
          }
        : {
            kind: "nodeCode",
            worktree,
            node: node.id,
            parent,
            fullNode: target,
            line,
          },
    );
  };
  const actionsFor = (target: FlowNode): ActionItem[] => {
    const item = (id: string, label: string, run: () => void): ActionItem => ({
      id,
      label,
      run,
      disabled: !canEdit || busy,
    });
    const actions = [
      item(
        "edit",
        target.component
          ? t("openComponent")
          : target.template
            ? countLabel(
                t,
                templateUsage(bundle, target.template),
                "editTemplateOne",
                "editTemplateCount",
              )
            : t("editNodeCode"),
        () =>
          target.component
            ? openComponent(target.id)
            : editCode(undefined, prefix + target.id),
      ),
    ];
    actions.push(
      item("duplicate", t("duplicateNode"), () =>
        safe(() => {
          const duplicate = {
            ...structuredClone(target),
            id: identifier(),
            position: { x: target.position.x + 40, y: target.position.y + 40 },
          };
          return insertNode((value) => {
            if (!duplicate.component) {
              const sql = nodeCode(value, target, parent);
              duplicate.origin = target.template || target.origin;
              delete duplicate.template;
              (value.node_sql ||= {})[
                nodeCodePath(duplicate.id, parent, duplicate.language)
              ] = sql;
            }
            nodeGraph(value, parent).nodes.push(duplicate);
            return duplicate.id;
          });
        }),
      ),
    );
    if (!target.component) {
      if (target.template) {
        actions.push(
          item("detach", t("detachTemplate"), () =>
            safe(() =>
              save(snapshot, (value) =>
                detachNode(
                  value,
                  nodeGraph(value, parent).nodes.find(
                    (n) => n.id === target.id,
                  )!,
                  parent,
                ),
              ),
            ),
          ),
        );
      } else {
        actions.push(
          item("convert", t("convertTemplate"), () =>
            openModal({
              kind: "convertNode",
              worktree,
              node: target.id,
              parent,
            }),
          ),
        );
        // Built-in templates are starting points: relinking would only drop the code.
        if (
          target.origin &&
          !isBuiltinTemplate(target.origin) &&
          bundle.templates[target.origin] !== undefined
        )
          actions.push(
            item("relink", t("relinkTemplate"), () =>
              openModal({
                kind: "relinkNode",
                worktree,
                node: target.id,
                parent,
              }),
            ),
          );
      }
    }
    actions.push({
      ...item("remove", t("deleteNode"), () =>
        safe(() => removeNodes([target.id])),
      ),
      danger: true,
    });
    return actions;
  };
  return (
    <div
      className={`flow-layout ${shown.palette ? "palette-open" : ""} ${shown.inspector || shown.code ? "inspector-open" : ""} ${shown.preview ? "preview-open" : ""} ${path.length ? "nested-flow" : ""}`}
      style={
        {
          "--notice-height": `${NOTICE_HEIGHT * noticeCount(snapshot, statuses.active, runDiagnostics)}px`,
          "--palette-width": `${sizes.sizes.palette}px`,
          "--inspector-width": `${codeShown ? sizes.sizes.code : sizes.sizes.inspector}px`,
          "--preview-height": `${sizes.sizes.preview}px`,
        } as CSSProperties
      }
    >
      <NodePalette
        readOnly={!canEdit || busy}
        snapshot={snapshot}
        excludedComponents={path.map((part) => part.definition)}
        hidden={!panels.open.palette}
        onClose={() => panels.set({ palette: false })}
        onAdd={(kind, id, linked) =>
          safe(() => addNode(kind, id, undefined, undefined, linked))
        }
        onNewTemplate={(language) =>
          openModal({
            kind: "template",
            worktree,
            template:
              identifier("template") + (language === "python" ? ".py" : ""),
            create: true,
          })
        }
        onLibrary={() => openModal({ kind: "library", worktree })}
      />
      {addingNode && (
        <div className="node-add-status" role="status">
          <Loader2 size={16} className="spin" aria-hidden="true" />
          {t("addingNode")}
        </div>
      )}
      <main className="canvas-column" inert={busy}>
        {/* Components show their own notice in this place. */}
        {!path.length && <BranchResultsNotice />}
        <CanvasHeader
          projectName={project?.name || bundle.flow.name}
          path={path}
          hasNode={!!node}
          paletteOpen={panels.open.palette}
          previewOpen={panels.open.preview}
          inspectorOpen={panels.open.inspector}
          selectionCount={canEdit ? selection.length : 0}
          onNavigate={(depth) => select(null, path.slice(0, depth))}
          onTogglePalette={() => panels.set({ palette: !panels.open.palette })}
          onTogglePreview={() => panels.set({ preview: !panels.open.preview })}
          onToggleInspector={() =>
            panels.set({ inspector: !panels.open.inspector })
          }
          onGroup={() =>
            openModal({
              kind: "group",
              worktree,
              nodes: selection,
              parent: path.at(-1)?.definition,
              prefix,
            })
          }
          onEditDefinition={() =>
            openModal({
              kind: "componentDefinition",
              worktree,
              component: path[path.length - 1].definition,
            })
          }
        />
        <div className="canvas">
          <Canvas
            ref={canvas}
            valueProducers={valueProducers}
            // Its delete keys listen on the document, which inert does not cover.
            readOnly={!canEdit || busy}
            nodes={graph.nodes}
            edges={graph.edges}
            parsed={snapshot.parsed_templates}
            names={snapshot.node_names}
            local={local}
            components={bundle.components}
            excludedComponents={path.map((part) => part.definition)}
            statuses={statuses}
            prefix={prefix}
            viewKey={worktree + ":" + path.map((p) => p.instance).join("/")}
            selected={selected}
            focusRequest={focusRequest}
            onSelect={select}
            onMove={(nodes) =>
              reported(
                updateGraph((g) => {
                  const positions = new Map(
                    nodes.map((n) => [n.id, n.position]),
                  );
                  g.nodes = g.nodes.map((n) => ({
                    ...n,
                    position: positions.get(n.id) ?? n.position,
                  }));
                }),
              )
            }
            onConnect={(connection) =>
              safe(() => updateGraph((g) => connectInput(g, connection)))
            }
            onDelete={(nodes, edges) => reported(removeNodes(nodes, edges))}
            onAdd={(kind, id, position, connection) =>
              safe(() => addNode(kind, id, position, connection))
            }
            onOpen={openComponent}
            actionsFor={(id) =>
              actionsFor(graph.nodes.find((node) => node.id === id)!)
            }
            exposedInputs={
              parent ? bundle.components[parent]?.inputs : undefined
            }
            onSelection={updateSelection}
            onWarnings={() => showResults("log")}
            onFailure={() => {
              setFailureFocus((value) => value + 1);
              showResults("data");
            }}
          />
        </div>
        {node && signature ? (
          <ResultsPanel
            readOnly={!canEdit}
            key={[worktree, fullNode, failureFocus, ...ports].join(":")}
            user={workspace.user.id}
            snapshot={snapshot}
            environment={environment}
            node={node}
            fullNode={fullNode}
            parent={parent}
            prefix={prefix}
            signature={signature}
            label={nodeLabel(node, signature, t)}
            graphNodes={graph.nodes}
            graphEdges={graph.edges}
            statuses={statuses}
            tab={resultsTab}
            hidden={!panels.open.preview}
            onTab={setResultsTab}
            onClose={() => panels.set({ preview: false })}
            onRun={() => run(fullNode)}
            onExplain={(value) => view.change({ cell: value })}
            onSave={(change) => save(snapshot, change)}
            onSaveDocumentation={(change) =>
              save(snapshot, (value) => change(value.documentation))
            }
            onAddFilter={addFilterNode}
            onEditCode={editCode}
            preview={
              preview?.node === fullNode && preview.environment === environment
                ? preview
                : null
            }
            onRunAncestors={runAncestors}
          />
        ) : null}
      </main>
      {cell && (
        <LineagePanel
          worktree={worktree}
          environment={environment}
          cell={cell}
          onClose={() => view.change({ cell: null })}
        />
      )}
      <div
        className="inspector-layer"
        id="node-inspector"
        hidden={!panels.open.inspector}
        inert={busy}
      >
        {node && definition && codeShown ? (
          <NodeCodePanel
            key={inspected}
            snapshot={snapshot}
            node={node}
            parent={parent}
            fullNode={fullNode}
            label={nodeLabel(node, signature!, t)}
            environment={environment}
            readOnly={!canEdit}
            statuses={statuses}
            preview={
              preview?.node === fullNode && preview.environment === environment
                ? preview
                : null
            }
            reveal={codeReveal}
            sample={sample}
            onSample={(size) => {
              setSample(size);
              // A shown preview follows the sample size.
              if (preview?.node === fullNode && !preview.missing?.length)
                void requestPreview(undefined, size);
            }}
            onPreview={(code) => void requestPreview(code)}
            onDraft={(code) => {
              codeDraft.current =
                code === null ? null : { node: fullNode, code };
            }}
            onClose={() => {
              view.change({ code: false });
              setCodeReveal(null);
            }}
          />
        ) : node && definition ? (
          <Inspector
            readOnly={!canEdit}
            key={inspected}
            node={node}
            parent={parent}
            signature={signature}
            snapshot={snapshot}
            graphNodes={graph.nodes}
            local={local}
            graphEdges={graph.edges}
            fullNode={fullNode}
            environment={environment}
            connections={connections}
            statuses={statuses}
            onSave={(updated, base, variables) =>
              fromInspector(
                inspected,
                save(base, (value) => {
                  const target = graphAt(value, path);
                  target.nodes = target.nodes.map((n) =>
                    n.id === updated.id ? updated : n,
                  );
                  if (!Object.keys(variables).length) return;
                  // A malformed file is never overwritten with new declarations.
                  const current = declarations(value);
                  if (!current) throw new Error(t("invalidVariablesFile"));
                  value.variables = { ...current, ...variables };
                }),
              )
            }
            onSaveDocumentation={(change, base) =>
              fromInspector(
                inspected,
                save(base, (value) => change(value.documentation)),
              )
            }
            onInput={(port, source) =>
              safe(() =>
                updateGraph((g) => {
                  if (!source) {
                    g.edges = g.edges.filter(
                      (e) => !(e.target === node.id && e.targetHandle === port),
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
            onEditTemplate={() => editCode()}
            actions={() =>
              actionsFor(node).filter(
                (action) => !["edit", "remove"].includes(action.id),
              )
            }
            onHistory={() =>
              openModal({
                kind: "git",
                worktree,
                mode: "compare",
                entity: nodeEntity(node.id, parent),
              })
            }
            onResults={showResults}
            onClose={() => panels.set({ inspector: false })}
          />
        ) : null}
      </div>
      <PanelResizeHandles panels={sizes} shown={shown} />
    </div>
  );
}
