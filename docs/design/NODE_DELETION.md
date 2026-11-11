# Deleting an intermediate node

See [the workspace guide](../WORKSPACE.md#build-and-inspect)
for the user-facing behavior.

## Ordinary removal and a secondary command

The inspector’s removal button deletes in one click. **Remove node** in the context
menu, Delete and Backspace also retain ordinary removal. Only eligible nodes offer
**Remove and reconnect** in the context menu, with its **Ctrl/Cmd+Delete** shortcut.
The shortcut does nothing when reconnection is unavailable and yields to typing,
menus and blocking dialogs. No remembered mode, global preference or confirmation
dialog changes ordinary removal.

For `A -> B -> C`, ordinary removal disconnects A and C; removal with reconnection
makes A feed C directly. Neither operation moves the remaining nodes. **Auto-arrange
nodes** remains a separate action. **Mute node (M)** keeps the node, its code and
links for a temporary bypass.

The [React Flow example](https://reactflow.dev/examples/nodes/delete-middle-node)
connects predecessors to successors. Duckpad additionally needs to preserve each
output and input port and enforce one source per input. Reconnecting every source
of a join to its consumers would be ambiguous.

Even one unambiguous connection can change the data: removing a filter admits more
rows, while removing a rename or aggregation can invalidate downstream SQL. This
limitation belongs in the documentation; the menu needs no explanatory text.
Reconnection does not execute the pipeline, guarantee schema compatibility or
rewrite references to the deleted node. Existing validation
and stale-result indicators continue to describe the modified project.

## Eligibility

Only a single SQL or Python transformation in the root flow can be removed with
reconnection. It must declare one input, one output and no external writes, have
one incoming link and at least one consumer, and expose a valid parsed interface.
All consumers are reconnected to the original upstream output. Their input ports
and link IDs are retained, as are unrelated links and node positions.

Sources, sinks, multi-port nodes, component instances, component internals and
multi-node selections keep ordinary deletion and do not offer reconnection. Invalid
endpoints, occupied inputs, duplicate destinations, self-links and cycles also
prevent reconnection.

## Saving and recovery

The frontend prepares the operation with `planNodeReconnection`, settles pending
editor drafts, and checks the current graph again. Changed incident connections
require another user action. Deleting the node and its owned SQL or Python file,
and reconnecting its consumers, form one saved change. Shared templates remain.

The save opts into `strict_revision`: under the worktree lock, the server rejects
a revision that is no longer current instead of merging a potentially stale
rewiring. Ordinary saves retain their existing merge behavior. A refused save
leaves the original graph visible and reports the error.

The success notification gives the number of reconnected links and offers **Undo**.
Undo and redo restore the node, owned code and links together and preserve later
independent edits. Their history retains its existing session lifetime; saved
changes persist across reloads.

Multi-port mapping, component-boundary rewrites and reconnection of a multi-node
selection remain outside this implementation.
