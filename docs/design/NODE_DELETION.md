# Deleting an intermediate node

Status: UX proposal for review. The reconnecting action described here is not
implemented.

## Recommendation

Offer an explicit **Remove node and reconnect** action alongside **Remove node**.
This saves manual rewiring when removing a step from a pipeline, while keeping
the existing deletion behavior predictable. Keep Delete and Backspace mapped to
ordinary removal. Use a choice at the point of action rather than a global
preference, a remembered mode or a confirmation dialog for every deletion.

For `A -> B -> C`:

| Action                    | Result                                                             | Intended use                                                            |
| ------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Remove node               | B and its incident links disappear; A and C remain disconnected.   | Remove a step and explicitly rebuild the affected part of the pipeline. |
| Remove node and reconnect | B disappears; A feeds C directly.                                  | Permanently omit a transformation while keeping the pipeline connected. |
| Mute node (existing)      | B, its code and its links remain; execution passes inputs through. | Temporarily try the pipeline without B's transformation.                |

Here, reconnecting means changing links. Keep the remaining nodes at their current
positions and preserve the viewport. The existing **Auto-arrange nodes** action
can close the visual gap when the user wants it.

## Why the choice matters in Duckpad

The [React Flow example](https://reactflow.dev/examples/nodes/delete-middle-node)
demonstrates reconnecting every predecessor to every successor. Duckpad links
specific output and input ports, and each input accepts only one source. Applying
that example directly to a join with two incoming sources would create competing
connections to a downstream input. Selecting one source implicitly would instead
change the meaning of the pipeline without an explicit choice.

Even an unambiguous connection can change the result: removing a filter admits
more rows; removing a rename or aggregation can leave downstream SQL referring
to columns that no longer exist. A connected graph does not guarantee compatible
data or equivalent results. Explain that data will bypass the removed step and
keep downstream validation and stale-result indicators visible. Do not start a
run automatically or describe reconnecting as preserving the result.

Duckpad already supports temporary bypass with **Mute node (M)**. Its positional
port mapping, including reusing the first input for extra outputs, is documented
in [the workspace guide](../WORKSPACE.md#build-and-inspect). Preserve that action
for experimentation; do not silently reuse its multi-port mapping for permanent
deletion.

## Proposed interaction

Expose both removal actions together in the node context menu and in an
accessible removal menu in the inspector. Use text labels to distinguish them;
do not rely on an unfamiliar icon or a modifier key. The inspector's existing
removal control can open that menu, with ordinary removal first. Both actions
respect the existing edit permissions and busy state.

Show **Remove node and reconnect** disabled when unavailable, with a reason
available to keyboard and pointer users, such as **Requires one connected input
and one output**. Near the reconnecting action, explain **Downstream nodes will
receive data directly from the previous step**. This is an explanation of the
effect, not a promise of schema compatibility.

After a successful save, show **Node removed; 2 links reconnected** with **Undo**
(using the actual count and localized singular/plural wording). One undo restores
the node, its code and parameters, and the original links; redo reapplies the
whole operation. A save failure leaves the original graph visible and reports
the error. No silent fallback from reconnecting to ordinary removal.

## First implementation boundary

Start with one selected SQL or Python transformation in the root flow, with a
valid interface declaring exactly one input and one output, exactly one incoming
link, and at least one outgoing link. The transformation must not declare external
writes. One output may feed several consumers: reconnect all of them to the same
upstream output, preserving each consumer's input port and all unrelated links.

Keep ordinary deletion available for sources, sinks, joins, nodes with multiple
ports, invalid interfaces, component instances, edits inside component definitions,
and multi-node selections. Reconnecting these cases needs a separate design:
component boundaries can expose the deleted node's ports or parameters, and
multiple selected nodes can form chains or branches. Do not guess a mapping or
partially reconnect a selection.

Preserve the upstream `sourceHandle` and each downstream `targetHandle`. Check
that endpoints still exist, the destination input has no competing source, and
the result introduces neither duplicate links, self-links nor cycles. Reject a
stale or invalid operation before saving. Use the existing validation path,
including partition and value-reference diagnostics; a new edge is not sufficient
evidence that the pipeline is valid.

## Implementation and acceptance notes

Current behavior is centralized in
[`removeFlowNodes`](../../frontend/src/flowEdits.ts) and
[`useFlowEditing`](../../frontend/src/useFlowEditing.ts). The canvas and the
inspector/context menu already call this path through
[`Canvas`](../../frontend/src/Canvas.tsx) and
[`nodeActions`](../../frontend/src/nodeActions.ts). Add an explicit removal mode
there and save deletion plus rewiring as one change. Avoid a separate React Flow
callback that updates only the displayed edges. The existing
[`connectInput`](../../frontend/src/graph.ts) replaces a destination's previous
source, so it must not silently overwrite an unrelated link during reconnection.

Before shipping the feature, verify:

- `A -> B -> C` reconnects A to C with the correct port IDs; ordinary removal and
  Delete/Backspace still leave them disconnected.
- One output feeding several consumers reconnects every consumer, while retaining
  unrelated nodes, links, positions and the viewport.
- Ineligible nodes and multiple selections explain why reconnection is unavailable;
  the action never guesses between input sources or alters exposed component ports.
- Undo and redo include the node's SQL or Python file and all affected links, persist
  the resulting graph, and preserve independent edits by another user. Undo history
  keeps its existing session lifetime.
- A rejected save or changed revision does not leave a partially removed or rewired
  graph; read-only users cannot invoke either removal action.
- Both menus work with keyboard navigation and screen readers, and all new labels
  and feedback are translated into the supported UI languages.
- Removing a schema-changing transformation surfaces downstream diagnostics rather
  than implying that reconnection preserves valid results.

The proposal can be accepted independently of implementation. Review the two-action
interaction and the initial eligibility boundary before extending it to multi-port
nodes or multi-node selections.
