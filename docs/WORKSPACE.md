# Find your way around

Open a project from **Projects** to enter its working branch. **Flow** is the
canvas; **Code** edits its files; **Documentation** explains the project;
**Variables** configures shared values; **Extensions** enables installed
capabilities; **History** lists executions. The top bar selects the environment.

## Build and inspect

Add a palette item by clicking it or dragging it onto the canvas. Connect an
output to an input, or choose the upstream output in the node's inspector.
Select a node for its parameters and code on the right and its
[results](RESULTS.md) below. Double-click a [component](COMPONENTS.md) to open
its contents; use the breadcrumbs to return. **Fit view** brings the graph into
view. Drag a port onto empty space to add a compatible connected node.

## Find nodes and projects

Use **Find a node…** to search the current graph by label, ID or template.
Choose a result with the mouse or the arrow keys and Enter to select and center
it. Inside a component, this searches that component's nodes.

**Search instance** in the top bar finds projects, open branches and placed
nodes across projects you can read, including nested components. Results show
their project, branch and component path; selecting one opens that location.
Search uses saved project metadata, never SQL, parameter values, connection
secrets or result rows. It does not run a pipeline or change the project.

Press **Ctrl+F** (**⌘F** on macOS) for canvas search or **Ctrl+K** (**⌘K**) for
instance search. Text editors, other form fields and open dialogs retain their
own keyboard shortcuts.

## Save and run

Save parameter or code edits before choosing **Run pipeline**. Completed saves
are versioned automatically, but execution is always explicit. Use a node's run
action for a smaller scope; Duckpad includes its upstream dependencies. **Stop**
requests cancellation of active SQL. A protected environment asks for confirmation.

Results belong to a branch and environment. A change can mark previous results
**Stale**, and a failed run retains the previous successful data. After a backend
restart, run again to restore previews and lineage. **History** retains execution
records; the node's **Log** connects the displayed data to its recorded run.
See [results and logs](RESULTS.md) and [environments](ENVIRONMENTS.md).

## Preferences and access

Use the account menu for **User settings**, including language and theme.
Duckpad supports English, French and Portuguese, with light and dark themes.
Preferences do not change project files. Available actions depend on your
[instance and project roles](INSTALLATION.md#accounts-and-project-access).

For your first working pipeline, follow [Duckpad in 15 minutes](QUICKSTART.md).
