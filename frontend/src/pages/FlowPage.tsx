import { Loader2 } from "lucide-react";
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
import {
  useLocation,
  useNavigationType,
  useOutletContext,
  useSearchParams,
} from "react-router";
import BranchResultsNotice from "../BranchResultsNotice";
import Canvas from "../Canvas";
import CanvasHeader from "../CanvasHeader";
import { noticeCount } from "../FlowToolbar";
import LineagePanel from "../LineagePanel";
import { type CodeReveal } from "../NodeCodePanel";
import NodePalette from "../NodePalette";
import ResultsPanel from "../ResultsPanel";
import RunFailureNotice from "../RunFailureNotice";
import {
  isWideLayout,
  PanelResizeHandles,
  usePanelSizes,
} from "../WorkspacePanels";
import type { CanvasHandle, FocusRequest } from "../canvasTypes";
import { insertOnEdge } from "../edgeInsertion";
import {
  connectInput,
  graphAt,
  identifier,
  nodeInterface,
  nodeChoices,
  pathPrefix,
  reconnectInput,
  resolveNodePath,
  type PathPart,
} from "../graph";
import { nodeLabel, useT } from "../i18n";
import {
  readLineageTarget,
  writeLineageTarget,
  type Cell,
  type ContributingRows,
  type LineageTarget,
} from "../lineageGraph";
import type { LineageMap } from "../LineageSteps";
import { nodeActions } from "../nodeActions";
import { localDefinitions, nodeLocation } from "../nodeCode";
import type { ResultsTab } from "../results";
import { useShell, useWorkspace } from "../shell";
import type { FlowNode } from "../types";
import { useDraftPreview } from "../useDraftPreview";
import { useFlowEditing } from "../useFlowEditing";
import { useLoadedWorktree } from "../worktree";
import FlowInspector from "../FlowInspector";
import type { FlowView } from "../useFlowView";
import { InvalidProject } from "./PageStates";

/** Height of each banner stacked under the toolbar, in pixels. */
const NOTICE_HEIGHT = 36;

export default function FlowPage() {
  const t = useT();
  const {
    notify,
    openModal,
    flowPanels: panels,
    preferences: { edgeStyle },
  } = useShell();
  const workspace = useWorkspace();
  const {
    id: worktree,
    environment,
    snapshot,
    statuses,
    runDiagnostics,
    canEdit,
    save,
    run,
  } = useLoadedWorktree();
  const view = useOutletContext<FlowView>();
  const { path, selected, cell } = view;
  const location = useLocation();
  const navigation = useNavigationType();
  const [params, setParams] = useSearchParams();
  const urlTarget = useMemo(() => readLineageTarget(params), [params]);
  const lineageTarget = useMemo(
    () =>
      urlTarget ||
      (cell
        ? {
            node: cell.node || pathPrefix(path) + (selected || ""),
            port: cell.port,
            direction: "origin" as const,
            cell,
          }
        : null),
    [urlTarget, cell, path, selected],
  );
  const [lineageMap, setLineageMap] = useState<LineageMap | null>(null);
  const [lineageHover, setLineageHover] = useState<string | null>(null);
  const [contributingRows, setContributingRows] =
    useState<ContributingRows | null>(null);
  const changeLineage = (target: LineageTarget | null) => {
    view.change({ cell: null });
    setContributingRows(null);
    const next = writeLineageTarget(params, target);
    // Choosing the explained cell again adds no history entry.
    if (next.toString() !== params.toString())
      // The node parameter makes the link shareable; in the page it is not a reveal.
      setParams(next, { state: { lineage: true } });
    if (target) panels.set({ inspector: true });
  };
  /** An explicit request for the inspector, code or palette details ends the exploration. */
  const closeLineage = () => {
    if (lineageTarget) changeLineage(null);
  };
  const sizes = usePanelSizes();
  const canvas = useRef<CanvasHandle>(null);
  const paletteTrigger = useRef<HTMLButtonElement | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [resultsTab, setResultsTab] = useState<ResultsTab>("data");
  const [failureFocus, setFailureFocus] = useState(0);
  // Badges and summary links open their results tab, even when the panel is hidden.
  const showResults = (tab: ResultsTab) => {
    setResultsTab(tab);
    panels.set({ preview: true });
  };
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [codeReveal, setCodeReveal] = useState<CodeReveal | null>(null);
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
  const {
    preview,
    sample,
    setSample,
    requestPreview,
    runAncestors,
    clearPreview,
    updateDraft,
  } = useDraftPreview({
    node,
    fullNode,
    worktree,
    environment,
    canEdit,
    statuses,
    run,
    showResults,
  });
  const signature = node
    ? nodeInterface(node, snapshot.parsed_templates, bundle?.components, local)
    : undefined;
  const definition = signature?.definition;
  const paletteChoice = view.paletteNode
    ? nodeChoices(
        snapshot.parsed_templates,
        bundle?.components || {},
        path.map((part) => part.definition),
      ).find(
        (choice) =>
          choice.kind === view.paletteNode?.kind &&
          choice.id === view.paletteNode.id,
      )
    : undefined;
  const ports = signature?.outputs || [];
  const project = workspace.projects.find(
    (p) => p.id === snapshot.worktree.project,
  );
  // The Inspector saves its draft when it closes, and can no longer show
  // the error of that save; report it instead.
  const inspected = worktree + fullNode;
  const shownInspector = useRef("");
  const inspectorShown =
    node && definition && !paletteChoice && panels.open.inspector
      ? inspected
      : "";
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
      clearPreview();
      setCodeReveal(null);
      if (resultsTab === "preview") setResultsTab("data");
    }
    view.change({
      selected: id,
      paletteNode: null,
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
  /** A node chosen on the canvas: an open lineage panel follows it, in the direction shown. */
  const chooseNode = (id: string | null) => {
    select(id);
    if (lineageTarget && id && prefix + id !== lineageTarget.node)
      changeLineage({
        node: prefix + id,
        direction: lineageTarget.direction,
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
      if (
        found.id &&
        (found.id !== selected || pathPrefix(found.path) !== prefix)
      )
        setFocusRequest({ id: found.id, key: location.key });
    },
  );
  // Reveal the node named by a search result, once per navigation.
  useEffect(() => {
    // Lineage keeps the node in its links; only Back or Forward reveals it again.
    if (
      !bundle ||
      view.revealed === location.key ||
      (location.state?.lineage && navigation !== "POP")
    )
      return;
    const target = new URLSearchParams(location.search).get("node");
    if (!target && !location.state?.searchResult) return;
    // A navigation, not a user event on this page, names the node to select.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- once per location key
    reveal(target ? resolveNodePath(bundle, target) : { path: [], id: null });
  }, [
    bundle,
    view.revealed,
    location.key,
    location.search,
    location.state,
    navigation,
  ]);

  const {
    addingNode,
    busy,
    updateGraph,
    addNode,
    dropFiles,
    removeNodes,
    reconnectNode,
    paste,
    addFilterNode,
    toggleMute,
  } = useFlowEditing({
    path,
    selected,
    selection,
    node,
    canvas,
    select,
    setFocusRequest,
    safe,
  });
  const componentPart = (instance: FlowNode & { component: string }) => ({
    instance: instance.id,
    definition: instance.component,
    label:
      instance.label ||
      bundle!.components[instance.component].name ||
      instance.id,
  });
  function openComponent(id: string) {
    const instance = graph?.nodes.find((n) => n.id === id);
    if (!instance?.component) return;
    select(null, [
      ...path,
      componentPart({ ...instance, component: instance.component }),
    ]);
  }

  function openLineageNode(id: string) {
    if (!bundle) return;
    const found = resolveNodePath(bundle, id);
    if (!found) return;
    const current = graphAt(bundle, found.path)?.nodes.find(
      (n) => n.id === found.id,
    );
    if (current?.component) {
      view.change({
        path: [
          ...found.path,
          componentPart({ ...current, component: current.component }),
        ],
        selected: null,
      });
    } else {
      view.change({ path: found.path, selected: found.id, paletteNode: null });
      if (found.id)
        setFocusRequest({
          id: found.id,
          key: String(Date.now()),
          reveal: true,
        });
    }
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
  const codeShown =
    !lineageTarget && !paletteChoice && view.code && hasCode && !!definition;
  const shown = {
    palette: panels.open.palette,
    inspector:
      !lineageTarget &&
      panels.open.inspector &&
      (!!node || !!paletteChoice) &&
      !codeShown,
    lineage: !!lineageTarget,
    preview: panels.open.preview && !!node,
    code: panels.open.inspector && codeShown,
  };
  const editCode = (line?: number, target = fullNode) => {
    // The code of a node of this graph docks beside the canvas, in the inspector's place.
    const shown = graph.nodes.find((item) => prefix + item.id === target);
    if (shown && !shown.component) {
      closeLineage();
      if (shown.id !== selected) select(shown.id);
      view.change({ code: true, paletteNode: null });
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
  const closePaletteDetails = () => {
    view.change({ paletteNode: null });
    // Small screens hid the palette to show its entry's details.
    if (!isWideLayout()) panels.set({ palette: true });
    requestAnimationFrame(() => paletteTrigger.current?.focus());
  };
  /** A node's main action: its code, or the contents of a component. */
  const openNode = (target: FlowNode) =>
    target.component
      ? openComponent(target.id)
      : editCode(undefined, prefix + target.id);
  const actionsFor = (target: FlowNode) =>
    nodeActions(target, {
      t,
      canEdit,
      busy,
      bundle,
      open: openNode,
      lineage: (target) => {
        select(target.id);
        changeLineage({ node: prefix + target.id, direction: "origin" });
      },
      safe,
      parent,
      paste,
      save,
      snapshot,
      openModal,
      worktree,
      removeNodes,
      reconnectNode,
      toggleMute,
    });
  return (
    <div
      className={`flow-layout ${shown.palette ? "palette-open" : ""} ${shown.inspector || shown.code || shown.lineage ? "inspector-open" : ""} ${shown.preview ? "preview-open" : ""} ${path.length ? "nested-flow" : ""}`}
      style={
        {
          "--notice-height": `${NOTICE_HEIGHT * noticeCount(snapshot, statuses.active, runDiagnostics)}px`,
          "--palette-width": `${sizes.sizes.palette}px`,
          "--inspector-width": `${lineageTarget ? sizes.sizes.lineage : codeShown ? sizes.sizes.code : sizes.sizes.inspector}px`,
          "--preview-height": `${sizes.sizes.preview}px`,
        } as CSSProperties
      }
    >
      <NodePalette
        readOnly={!canEdit}
        busy={busy}
        snapshot={snapshot}
        excludedComponents={path.map((part) => part.definition)}
        hidden={!panels.open.palette}
        onClose={() => panels.set({ palette: false })}
        inspected={panels.open.inspector ? view.paletteNode : null}
        onDismiss={closePaletteDetails}
        onInspect={(kind, id, trigger, keyboard) => {
          paletteTrigger.current = trigger;
          closeLineage();
          view.change({ paletteNode: { kind, id, keyboard }, cell: null });
          panels.set({
            inspector: true,
            ...(isWideLayout() ? {} : { palette: false }),
          });
        }}
        onAdd={(kind, id, linked) =>
          safe(() => addNode(kind, id, undefined, undefined, linked))
        }
        onDragStart={(kind, id, transfer) =>
          canvas.current?.previewDrag(kind, id, transfer)
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
        <RunFailureNotice />
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
            lineageTarget
              ? closeLineage()
              : panels.set({ inspector: !panels.open.inspector })
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
            lineage={lineageTarget ? lineageMap : null}
            lineageHover={lineageHover}
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
            onSelect={chooseNode}
            onDismiss={() => {
              if (!lineageTarget) return false;
              closeLineage();
              return true;
            }}
            onMove={(nodes, insertion) =>
              reported(
                updateGraph((g) => {
                  const positions = new Map(
                    nodes.map((n) => [n.id, n.position]),
                  );
                  g.nodes = g.nodes.map((n) => ({
                    ...n,
                    position: positions.get(n.id) ?? n.position,
                  }));
                  if (insertion && nodes.length === 1)
                    insertOnEdge(g, nodes[0].id, insertion);
                }),
              )
            }
            onConnect={(connection) =>
              safe(() => updateGraph((g) => connectInput(g, connection)))
            }
            onReconnect={(id, connection) =>
              safe(() => updateGraph((g) => reconnectInput(g, id, connection)))
            }
            onCycle={() => notify(t("connectionCycle"), true)}
            onDelete={(nodes, edges) => reported(removeNodes(nodes, edges))}
            onFiles={(files, position) =>
              safe(() => dropFiles(files, position))
            }
            onAdd={(kind, id, position, connection, insertion) =>
              safe(() =>
                addNode(kind, id, position, connection, false, insertion),
              )
            }
            onOpen={(id) => {
              const target = graph.nodes.find((item) => item.id === id);
              if (target) openNode(target);
            }}
            actionsFor={(id) =>
              actionsFor(graph.nodes.find((node) => node.id === id)!)
            }
            exposedInputs={
              parent ? bundle.components[parent]?.inputs : undefined
            }
            exposedOutputs={
              parent ? bundle.components[parent]?.outputs : undefined
            }
            edgeStyle={edgeStyle}
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
            onRun={(options) => run(fullNode, options)}
            selectedCell={lineageTarget?.cell}
            onColumnLineage={(node, port, column) =>
              changeLineage({ node, port, column, direction: "origin" })
            }
            onExplain={(value) =>
              changeLineage({
                node: value.node || fullNode,
                port: value.port,
                // Following rows one after another stays on their downstream fate.
                direction: lineageTarget?.cell
                  ? lineageTarget.direction
                  : "origin",
                cell: value,
              })
            }
            preferredPort={
              lineageTarget?.node === fullNode ? lineageTarget.port : undefined
            }
            contributingRows={
              contributingRows?.input.node === fullNode
                ? contributingRows
                : null
            }
            onClearContributions={() => setContributingRows(null)}
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
      {lineageTarget && (
        <LineagePanel
          target={lineageTarget}
          onChange={changeLineage}
          onClose={() => {
            changeLineage(null);
            // Focus returns to the node whose inspector comes back.
            if (selected)
              setFocusRequest({ id: selected, key: String(Date.now()) });
          }}
          onMap={setLineageMap}
          onHover={setLineageHover}
          onOpen={openLineageNode}
          onLocate={() => {
            const found = bundle && resolveNodePath(bundle, lineageTarget.node);
            if (!found) return;
            setContributingRows(null);
            view.change({
              path: found.path,
              selected: found.id,
              paletteNode: null,
            });
            setFocusRequest({
              id: found.id,
              key: String(Date.now()),
              reveal: true,
            });
            showResults("data");
          }}
          onRows={(rows) => {
            setContributingRows(rows);
            openLineageNode(rows.input.node || "");
            showResults("data");
          }}
        />
      )}
      {!lineageTarget && (
        <FlowInspector
          paletteChoice={paletteChoice}
          paletteFocus={!!view.paletteNode?.keyboard}
          onClosePalette={closePaletteDetails}
          onAddPalette={
            canEdit && paletteChoice
              ? () => safe(() => addNode(paletteChoice.kind, paletteChoice.id))
              : undefined
          }
          panels={panels}
          busy={busy}
          node={node}
          definition={definition}
          codeShown={codeShown}
          inspected={inspected}
          snapshot={snapshot}
          parent={parent}
          fullNode={fullNode}
          signature={signature}
          environment={environment}
          canEdit={canEdit}
          statuses={statuses}
          preview={preview}
          codeReveal={codeReveal}
          sample={sample}
          setSample={setSample}
          requestPreview={requestPreview}
          updateDraft={updateDraft}
          view={view}
          setCodeReveal={setCodeReveal}
          graph={graph}
          local={local}
          connections={connections}
          fromInspector={fromInspector}
          save={save}
          path={path}
          safe={safe}
          updateGraph={updateGraph}
          run={run}
          actionsFor={actionsFor}
          openModal={openModal}
          showResults={showResults}
        />
      )}
      <PanelResizeHandles panels={sizes} shown={shown} />
    </div>
  );
}
