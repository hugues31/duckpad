import { type Ref } from "react";
import { type ActionItem } from "./ActionMenu";
import type { EdgeInsertion } from "./edgeInsertion";
import type { NodeKind } from "./graph";
import { type NodeConnection } from "./graph";
import { type NodeNames } from "./nodeNames";
import type {
  ComponentDefinition,
  ComponentPort,
  EdgeStyle,
  FlowEdge,
  FlowNode,
  ParsedTemplate,
  Statuses,
} from "./types";

export interface CanvasHandle {
  newNodePosition: (nodes: FlowNode[]) => FlowNode["position"];
  previewDrag: (kind: NodeKind, id: string, transfer: DataTransfer) => void;
}

export interface FocusRequest {
  id: string;
  key: string;
  /** Keep the zoom and pan only if the node is hidden, as for a new node. */
  reveal?: boolean;
}

export interface CanvasProps {
  lineage?: import("./LineageSteps").LineageMap | null;
  lineageHover?: string | null;
  names?: NodeNames;
  ref?: Ref<CanvasHandle>;
  readOnly?: boolean;
  nodes: FlowNode[];
  edges: FlowEdge[];
  parsed: Record<string, ParsedTemplate>;
  local?: Record<string, ParsedTemplate>;
  components: Record<string, ComponentDefinition>;
  excludedComponents: string[];
  valueProducers?: string[];
  statuses: Statuses;
  prefix: string;
  viewKey: string;
  selected: string | null;
  focusRequest?: FocusRequest | null;
  onSelect: (id: string | null) => void;
  onMove: (nodes: FlowNode[], insertion?: EdgeInsertion) => Promise<void>;
  onConnect: (edge: Omit<FlowEdge, "id">) => void;
  onReconnect: (id: string, edge: Omit<FlowEdge, "id">) => void;
  /** A link was refused because it would make a node read its own data. */
  onCycle: () => void;
  /** Resolve once the deletion is saved; reject if it failed. */
  onDelete: (nodes: string[], edges: string[]) => Promise<void>;
  onAdd: (
    kind: NodeKind,
    id: string,
    position?: { x: number; y: number },
    connection?: NodeConnection,
    insertion?: EdgeInsertion,
  ) => void;
  onFiles?: (files: File[], position: { x: number; y: number }) => void;
  actionsFor: (id: string) => ActionItem[];
  /** Inputs of the opened component definition, connected from outside it. */
  exposedInputs?: Record<string, ComponentPort>;
  /** Outputs of the opened component definition, used outside it. */
  exposedOutputs?: Record<string, ComponentPort>;
  /** How links are drawn; curved by default. */
  edgeStyle?: EdgeStyle;
  onOpen: (id: string) => void;
  onSelection: (ids: string[]) => void;
  /** Show the results log of a node whose warning badge was clicked. */
  onWarnings?: (id: string) => void;
  /** Show the error of a node whose Failed badge was clicked. */
  onFailure?: (id: string) => void;
}
