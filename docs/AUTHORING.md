# Authoring projects

A project holds a graph, SQL, reusable components and documentation. Start with
the [quickstart](QUICKSTART.md) to build a pipeline; this guide covers its files
and code ownership.

## Edit and share project files

The **Code** tab displays the worktree's files beside an editor. Choose a file,
edit it, then **Save changes**. Drafts survive switching files or workspace tabs.
External editors are also supported. Every completed save is committed, including
invalid content; fix the reported errors before running affected nodes. SQL and
Python files get the [completion, hovers and checks](SQL.md#completion-hovers-and-problems)
of the docked editor, and in `flow.json` a `"$var": "` reference suggests the
project variables.

**Download project ZIP** exports the saved declarative files below. Save or
discard pending edits first. Readers can download; editing requires Editor access.
The archive excludes Git history, source data, results, virtual environments and
instance connection settings.

To import, choose **New project → Import a project ZIP**. Leave the name empty to
use the one in `flow.json`. A single enclosing folder, as in a Git repository
download, is accepted. The import creates a new project and Git history, with you
as administrator. Upload source files again and ask an instance administrator to
grant any required connections. The import reports missing connections and
absolute source paths that need attention.

Archives over 16 MiB (64 MiB extracted), without `flow.json`, or containing invalid
JSON or non-UTF-8 declarative files are rejected. Non-project entries are ignored.

![Project files and the SQL template editor in the Code workspace](images/code.png)

## Project layout and Python dependencies

```text
README.md              Project overview
pyproject.toml         Python version and dependencies
uv.lock                Locked Python dependencies (when Python is enabled)
flow.json              Pipeline graph and partition declarations
documentation.json     Node, output and column descriptions
variables.json         Ordinary and computed variable declarations (optional)
extensions.json        Project extension requirements (optional)
views.json             Shared result views (optional)
charts.json            Vega-Lite charts of node outputs (optional)
templates/*.sql        Shared SQL templates
nodes/*.sql            Code owned by normal nodes
components/*.json      Reusable sub-flows
components/<id>/*.sql   Code owned by nodes inside a component
nodes/*.py             Python node code
templates/*.py         Shared Python templates
components/<id>/*.py    Python code inside a component
modules/**/*.py        Shared Python helper modules
```

Project prose belongs in `README.md`; `documentation.json` rejects a `project`
entry. A missing or empty README means no project overview.

New projects declare the server's Python ABI, DuckDB version and SDK contract
in `pyproject.toml`. Edit `project.dependencies` to add business packages; comments and
custom TOML tables survive UI saves. Malformed TOML remains editable with a
diagnostic.

The manifest sets `tool.uv.package = false` because the project is a pipeline.
See [Python nodes](PYTHON.md) for activation, locking, runtime compatibility and
authoring.

## Editing node code

Palette entries, **Add a connected node** and **Duplicate node** copy SQL into
independent nodes. The **SQL** entry in the palette list starts with a `source`
input and `result` output. **Edit code** changes only that node. Its `-- @param`
declarations generate the form; guided controls remain while their supporting
parameters are present.

The **SQL** and **Python** buttons at the bottom of the palette create reusable
templates. Python requires administrator activation in the project settings.
The template is saved as you edit it and appears in the palette; drag
the entry to create independent nodes. **Import** copies a reusable definition from
another project into this palette.

To share a template, right-click its palette entry and choose
**Add linked**. Linked nodes show a badge and template name. **Edit template
(N nodes)** opens the shared template in the code editor; editing it changes
every linked instance in the branch. The other actions below are icons under
that button in the inspector, and entries of the node's right-click menu. **Detach
from template** copies the SQL while retaining parameters and connections.

**Convert to template** names a new shared definition and links the node to it.
**Link to original template**, offered for nodes that come from a project
template, asks before discarding local code. Detaching or converting preserves
valid results; relinking to different executable SQL makes results stale.
Linked code has no partial overrides.

![A normal node owns its code and offers explicit template conversions](images/node-code.png)

The inspector's **Info** tab shows the node's ID, code file, creator, contributors
and last change, including whether it touched processing, documentation or layout.
Linked nodes also show the template's last change. **View change history** opens
its element history in the [Git workspace](GIT.md).

## Saved views

The results panel saves shared samples in `views.json`. External editors can
use the same format:

```json
{
  "validated:orders": [
    {
      "name": "Partner orders above 300",
      "rows": 100,
      "method": "first",
      "filter": "channel = 'Partner' AND amount > 300",
      "order": [["amount", "desc"]]
    }
  ]
}
```

Views are keyed by `node:port`, like dataset documentation. A view has a `name`,
unique for its output, and optionally `rows` (1 to 10,000), `method` (`first` or
`random`), `seed`, `filter` and `order` (`[column, "asc" | "desc"]` pairs).

See [results and samples](RESULTS.md#data-and-samples) to create one in the UI.

## Charts

`charts.json` declares named Vega-Lite charts per node output, keyed like
views. The [charts guide](CHARTS.md) describes its format, the allowed specs and
how the Chart tab draws them.

## Related guides

- [SQL syntax](SQL.md): declarations, parameters, sources and exports.
- [Components](COMPONENTS.md): grouping and sharing multiple steps.
- [Variables](VARIABLES.md) and [partitions](PARTITIONS.md): shared values and batches.
- [Data preparation](DATA_PREPARATION.md): guided column and value operations.
- [Documentation](DOCUMENTATION.md), [Git](GIT.md) and [Jobs](JOBS.md): explain,
  review and run saved versions.
