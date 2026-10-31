import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useLocation, useOutletContext } from "react-router";
import Canvas from "../Canvas";
import CanvasHeader from "../CanvasHeader";
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
import { useT } from "../i18n";
import Inspector from "../Inspector";
import {
  NEW_NODE_SQL,
  detachNode,
  localDefinitions,
  nodeCode,
  nodeCodePath,
  nodeGraph,
} from "../nodeCode";
import LineagePanel from "../LineagePanel";
import type { Cell } from "../lineageGraph";
import NodePalette, { type NodeKind } from "../NodePalette";
import Preview, { useNodePreview } from "../Preview";
import { useShell, useWorkspace } from "../shell";
import type { Bundle, FlowNode, Graph } from "../types";
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

interface FlowLocation {
  worktree: string;
  environment: string;
  path: PathPart[];
  selected: string | null;
  /** The history entry whose `node` parameter was revealed last. */
  revealed: string;
  /** The result cell whose lineage is explained. */
  cell: Cell | null;
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
  const { notify, openModal, flowPanels: panels } = useShell();
  const workspace = useWorkspace();
  const {
    id: worktree,
    environment,
    snapshot,
    statuses,
    canEdit,
    save,
    run,
  } = useLoadedWorktree();
  const view = useOutletContext<FlowView>();
  const { path, selected, cell } = view;
  const location = useLocation();
  const sizes = usePanelSizes();
  const [selection, setSelection] = useState<string[]>([]);
  const [focusRequest, setFocusRequest] = useState<{
    id: string;
    key: string;
  } | null>(null);
  const bundle = snapshot.bundle;
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
  const preview = useNodePreview({
    worktree,
    environment,
    node: node && ports.length ? fullNode : null,
    ports,
    version: JSON.stringify(statuses.nodes),
  });
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

  async function updateGraph(change: (graph: Graph) => void) {
    if (!canEdit) return;
    await save(snapshot, (value) => change(graphAt(value, path)));
  }
  async function addNode(
    kind: NodeKind,
    id: string,
    position = {
      x: 160 + ((graph?.nodes.length || 0) % 4) * 240,
      y: 120 + Math.floor((graph?.nodes.length || 0) / 4) * 210,
    },
    connection?: NodeConnection,
    linked = false,
  ) {
    if (connection && !graph?.nodes.some((n) => n.id === connection.nodeId))
      return;
    const created: FlowNode = {
      id: identifier(),
      ...(kind === "component" ? { component: id } : { template: id }),
      params: {},
      position,
    };
    await save(snapshot, (value) => {
      const g = graphAt(value, path);
      if (kind === "template" && !linked) {
        if (id) detachNode(value, created, parent);
        else {
          delete created.template;
          (value.node_sql ||= {})[nodeCodePath(created.id, parent)] =
            NEW_NODE_SQL;
        }
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
    });
    select(created.id);
  }
  async function removeNodes(ids: string[], edges: string[] = []) {
    await save(snapshot, (value) => {
      const g = graphAt(value, path);
      ids.forEach((id) => delete value.node_sql?.[nodeCodePath(id, parent)]);
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
  const shown = {
    palette: panels.open.palette,
    inspector: panels.open.inspector && !!node,
    preview: panels.open.preview && !!node && ports.length > 0,
  };
  return (
    <div
      className={`flow-layout ${shown.palette ? "palette-open" : ""} ${shown.inspector ? "inspector-open" : ""} ${shown.preview ? "preview-open" : ""} ${path.length ? "nested-flow" : ""}`}
      style={
        {
          "--notice-height": `${NOTICE_HEIGHT * noticeCount(snapshot, statuses.active)}px`,
          "--palette-width": `${sizes.sizes.palette}px`,
          "--inspector-width": `${sizes.sizes.inspector}px`,
          "--preview-height": `${sizes.sizes.preview}px`,
        } as CSSProperties
      }
    >
      <NodePalette
        readOnly={!canEdit}
        snapshot={snapshot}
        excludedComponents={path.map((part) => part.definition)}
        hidden={!panels.open.palette}
        onClose={() => panels.set({ palette: false })}
        onAdd={(kind, id, linked) =>
          safe(() => addNode(kind, id, undefined, undefined, linked))
        }
        onNewNode={() => safe(() => addNode("template", ""))}
        onNewTemplate={() =>
          openModal({
            kind: "template",
            worktree,
            template: identifier("template"),
            create: true,
          })
        }
        onLibrary={() => openModal({ kind: "library", worktree })}
      />
      <main className="canvas-column">
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
            readOnly={!canEdit}
            nodes={graph.nodes}
            edges={graph.edges}
            parsed={snapshot.parsed_templates}
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
            onSelection={updateSelection}
          />
        </div>
        {node && ports.length > 0 ? (
          <Preview
            readOnly={!canEdit}
            key={[worktree, fullNode, environment, ...ports].join(":")}
            snapshot={snapshot}
            environment={environment}
            preview={preview}
            ports={ports}
            active={!!statuses.active}
            hidden={!panels.open.preview}
            onClose={() => panels.set({ preview: false })}
            onRun={() => run(fullNode)}
            onExplain={(value) => view.change({ cell: value })}
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
      >
        {node && definition ? (
          <Inspector
            readOnly={!canEdit}
            key={inspected}
            node={node}
            signature={signature}
            snapshot={snapshot}
            graphNodes={graph.nodes}
            local={local}
            graphEdges={graph.edges}
            fullNode={fullNode}
            environment={environment}
            connections={connections}
            statuses={statuses}
            preview={preview.data}
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
            onEditTemplate={() =>
              openModal(
                node.template
                  ? {
                      kind: "template",
                      worktree,
                      template: node.template,
                    }
                  : { kind: "nodeCode", worktree, node: node.id, parent },
              )
            }
            onViewCode={() =>
              openModal({ kind: "nodeCode", worktree, node: node.id, parent })
            }
            onDetach={() =>
              safe(() =>
                save(snapshot, (value) => {
                  detachNode(
                    value,
                    nodeGraph(value, parent).nodes.find(
                      (n) => n.id === node.id,
                    )!,
                    parent,
                  );
                }),
              )
            }
            onConvert={() =>
              openModal({
                kind: "convertNode",
                worktree,
                node: node.id,
                parent,
              })
            }
            onRelink={() =>
              openModal({ kind: "relinkNode", worktree, node: node.id, parent })
            }
            onDuplicate={() =>
              safe(async () => {
                const duplicate = {
                  ...structuredClone(node),
                  id: identifier(),
                  position: {
                    x: node.position.x + 40,
                    y: node.position.y + 40,
                  },
                };
                await save(snapshot, (value) => {
                  if (!duplicate.component) {
                    const sql = nodeCode(value, node, parent);
                    duplicate.origin = node.template || node.origin;
                    delete duplicate.template;
                    (value.node_sql ||= {})[
                      nodeCodePath(duplicate.id, parent)
                    ] = sql;
                  }
                  nodeGraph(value, parent).nodes.push(duplicate);
                });
                select(duplicate.id);
              })
            }
            onHistory={() =>
              openModal({
                kind: "git",
                worktree,
                mode: "compare",
                entity: `${path.length ? `component/${path[path.length - 1].definition}/` : ""}node/${node.id}`,
              })
            }
            onClose={() => panels.set({ inspector: false })}
          />
        ) : null}
      </div>
      <PanelResizeHandles panels={sizes} shown={shown} />
    </div>
  );
}
