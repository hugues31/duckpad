# Reusable components

Package several connected steps as one node, expose their parameters and reuse
the same logic across a project or import an independent copy elsewhere.

## Nodes and connections

`flow.json` holds `nodes` and `edges`. Normal nodes own `nodes/<node-id>.sql` and have no `template` field. Linked nodes reference a local `template`; component instances reference a local `component`. All own their parameters and position. An optional `origin` records where normal code came from without linking it. An optional `preset` retains the palette icon and guided form after conversions or imports; it never selects executable code. Edges use stable `source`, `sourceHandle`, `target` and `targetHandle` IDs. Selecting an input in the inspector edits the same edge as dragging a port connection. An input has at most one source; an output can feed many inputs.

Drag an input or output connection onto empty canvas space to open **Add a connected node**. Search the local templates and components, then choose a port to create the node at the drop position and connect it in one save. The list only offers nodes with ports in the required direction. Use the arrow keys and Enter, or click a result; Escape or a click outside cancels without changing the graph. Starting from an occupied input replaces its previous connection when the new node is added.

## Group and open components

Select nodes using Shift, then choose **Group into component**. Node-owned code moves to `components/<component-id>/<node-id>.sql`. Incoming and outgoing edges are preserved as named boundary ports; terminal outputs remain inspectable. Double-click the resulting node to open the sub-flow. Breadcrumbs identify the instance path. Definition edits affect every usage in this project branch, while parameters belong to the selected instance.

![The nested Regional summary component, its breadcrumb path and metrics output](images/component.png)

## Expose parameters

Exposed component parameters have the following structure:

```json
{
  "minimum": {
    "type": "number",
    "default": 100,
    "targets": [{"node": "filter_node", "param": "threshold"}]
  }
}
```

## Import a component

The shared library reads projects' main branches. Importing creates new destination-owned IDs for the component, nested components and templates. Node-owned SQL, definitions and documentation are copied; data, results and secrets are not. Imports never resolve executable code through the original project. Subsequent edits are independent.

See [node code and linked templates](AUTHORING.md#editing-node-code) for reusing
a single SQL definition, or [variables](VARIABLES.md) to configure an instance.
