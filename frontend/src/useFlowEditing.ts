import {
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { api, send, uploadSourceFile } from "./api";
import type { CanvasHandle, FocusRequest } from "./canvasTypes";
import {
  addFlowFilter,
  addFlowNode,
  dropFlowFiles,
  removeFlowNodes,
} from "./flowEdits";
import {
  graphAt,
  identifier,
  type NodeConnection,
  type NodeKind,
  type PathPart,
} from "./graph";
import { findNodePosition } from "./graphLayout";
import { countLabel, useT } from "./i18n";
import { canMute } from "./nodeCode";
import { planNodeReconnection } from "./nodeRemoval";
import {
  copyNodes,
  pastableNodes,
  pasteNodes,
  type CopiedNodes,
} from "./nodeClipboard";
import { useShell } from "./shell";
import { isFileReader, isSourceFile } from "./SourceFileField";
import { previewFile } from "./SourcePreview";
import type { Bundle, FlowNode, Graph, Json, Snapshot } from "./types";
import { useFlowShortcuts } from "./useFlowShortcuts";
import { useLoadedWorktree } from "./worktree";
export function useFlowEditing({
  path,
  selected,
  selection,
  node,
  canvas,
  select,
  setFocusRequest,
  safe,
}: {
  path: PathPart[];
  selected: string | null;
  selection: string[];
  node: FlowNode | undefined;
  canvas: RefObject<CanvasHandle | null>;
  select: (id: string | null) => void;
  setFocusRequest: Dispatch<SetStateAction<FocusRequest | null>>;
  safe: (action: () => Promise<unknown>) => void;
}) {
  const t = useT();
  const { notify, drafts } = useShell();
  const {
    id: worktree,
    snapshot,
    canEdit,
    saving,
    settle,
    save,
    commit,
    undo,
    redo,
  } = useLoadedWorktree();
  const bundle = snapshot.bundle;
  const graph = bundle ? graphAt(bundle, path) : undefined;
  const parent = path.at(-1)?.definition;
  const [addingNode, setAddingNode] = useState(false);
  const additionPending = useRef(false);
  // Undos and redos in flight; editors stay inert so no edit races them.
  const [reverting, setReverting] = useState(0);
  // A reconnection in flight; a second one would plan on the graph it replaces.
  const [removing, setRemoving] = useState(false);
  const removalPending = useRef(false);
  const busy = addingNode || reverting > 0 || removing;
  async function updateGraph(change: (graph: Graph) => void) {
    if (!canEdit) return;
    await save(snapshot, (value) => change(graphAt(value, path)));
  }
  async function toggleMute(ids: string[]) {
    if (!canEdit || busy || saving || !bundle) return;
    const eligible = graph!.nodes.filter(
      (item) => ids.includes(item.id) && canMute(snapshot, item, parent),
    );
    if (!eligible.length) return;
    const muted = !eligible.every((item) => item.muted);
    await updateGraph((value) => {
      for (const item of value.nodes) {
        if (!eligible.some((candidate) => candidate.id === item.id)) continue;
        if (muted) item.muted = true;
        else delete item.muted;
      }
    });
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
      params: isFileReader(id) ? { file: "" } : {},
      position:
        position ??
        canvas.current?.newNodePosition(graph?.nodes || []) ??
        findNodePosition(graph?.nodes || []),
    };
    const added = await insertNode((value) =>
      addFlowNode(value, path, created, kind, linked, connection),
    );
    if (added && !position)
      setFocusRequest({ id: created.id, key: created.id, reveal: true });
  }
  async function dropFiles(dropped: File[], position: FlowNode["position"]) {
    if (!canEdit || additionPending.current) return;
    const files = dropped.filter((file) => isSourceFile(file.name));
    const skipped = dropped.filter((file) => !isSourceFile(file.name));
    const unsupported = t("unsupportedSourceFile").replace(
      "{files}",
      skipped.map((file) => file.name).join(", "),
    );
    if (!files.length) throw new Error(unsupported);
    // Supported files are still imported; the others are named.
    if (skipped.length) notify(unsupported, true);
    additionPending.current = true;
    setAddingNode(true);
    try {
      const uploads: (Awaited<ReturnType<typeof uploadSourceFile>> & {
        settings: Record<string, Json>;
      })[] = [];
      for (const file of files) {
        const uploaded = await uploadSourceFile(file, worktree);
        // A file the sniffer cannot read still gets its node, whose preview shows the error.
        const settings =
          uploaded.template === "load_csv"
            ? await previewFile(worktree, { file: uploaded.path }).then(
                (sample) => sample.settings || {},
                () => ({}),
              )
            : {};
        uploads.push({ ...uploaded, settings });
      }
      let selected = "";
      const prepared = uploads.map((upload) => ({
        ...upload,
        id: identifier(),
      }));
      await save(snapshot, (value) => {
        selected = dropFlowFiles(value, path, prepared, position);
      });
      select(selected);
    } finally {
      additionPending.current = false;
      setAddingNode(false);
    }
  }
  async function removeNodes(ids: string[], edges: string[] = []) {
    const { change } = await save(snapshot, (value) =>
      removeFlowNodes(value, path, ids, edges),
    );
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
  /** Remove a node and link its source to its consumers, as one change. */
  async function reconnectNode(id: string) {
    if (!canEdit || busy || removalPending.current) return;
    removalPending.current = true;
    setRemoving(true);
    try {
      let links = 0;
      // Plan on the saved graph: a pending draft may have changed the node's ports.
      const { change } = await commit((base) => {
        const reconnected = planNodeReconnection(base, id, parent);
        if (!reconnected) throw new Error(t("reconnectChanged"));
        links = reconnected.length;
        const bundle = structuredClone(base.bundle!);
        removeFlowNodes(bundle, path, [id], [], reconnected);
        return api<Snapshot>(
          `/worktrees/${worktree}`,
          send({ revision: base.revision, bundle }, "PUT"),
        );
      });
      if (selected === id) select(null);
      if (change)
        notify(
          countLabel(t, links, "nodeReconnectedOne", "nodeReconnectedMany"),
          false,
          { label: t("undo"), run: () => revert("undo", change) },
        );
    } finally {
      removalPending.current = false;
      setRemoving(false);
    }
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
  async function paste(copied: CopiedNodes, detach = false) {
    const opened = path.map((part) => part.definition);
    if (!pastableNodes(bundle!, copied, opened).length) {
      notify(t("nothingPasted"), true);
      return;
    }
    let ids: string[] = [];
    const added = await insertNode((value) => {
      ids = pasteNodes(value, parent, copied, opened, { detach });
      return ids[0];
    });
    if (added) setFocusRequest({ id: ids[0], key: ids[0], reveal: true });
  }
  // Undo, redo, copy and paste yield to typing and to blocking dialogs.
  useFlowShortcuts({
    canEdit,
    addingNode,
    bundle,
    graph,
    selection,
    selected,
    busy,
    revert,
    safe,
    copy,
    paste,
    toggleMute,
    reconnect: async (id) => {
      if (planNodeReconnection(snapshot, id, parent)) await reconnectNode(id);
    },
  });
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
    const added = await insertNode((value) =>
      addFlowFilter(value, path, created, node, port, reusable, filter),
    );
    if (added) notify(t("filterNodeAdded"));
  }

  return {
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
  };
}
