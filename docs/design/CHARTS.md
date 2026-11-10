# Charts on node outputs (design proposal)

**Status: accepted on 9 November 2026 in issue #221 (see [Decisions](#decisions))
and implemented.** See [Charts](../CHARTS.md) for the current interface and file
format. This record settles the file format, validation,
rendering and Git behavior of a first, read-only charting step.

## Summary

A project declares named Vega-Lite charts per node output in a new optional
file, `charts.json`. The results panel gets a read-only **Chart** tab that
renders them from the retained result. Charts are presentation: like saved
views, they never start a run or make a result stale. All shaping
(aggregation, binning, filtering) stays in SQL nodes, so every plotted value is
a cell of a node output and keeps its lineage.

## Problem

A result can only be inspected row by row. To see a trend, a dip or an outlier,
users export the data to another tool, which breaks the link between the
picture and the pipeline that produced it.

A chart that aggregates inside its own spec would recreate that break inside
Duckpad: a plotted value would come from a computation outside the graph,
without lineage, tests or review. Charts therefore only map columns to visual
channels.

## Decisions

Accepted:

1. Charts are presentation on a node output, shown in a results-panel tab. A
   canvas chart node is not added.
2. `charts.json` is keyed by stored output (`node:port`, or
   `instance::node:port` inside a component instance), like `views.json`.
3. A spec passes a structural **allowlist** of marks, channels and channel
   properties. Anything else is a diagnostic.
4. Rendering always uses `ast: true` with `vega-interpreter`, a loader that
   blocks every request and no actions menu. The tab renders nothing while
   `charts.json` has diagnostics.
5. The tab reads the existing preview endpoint with `limit=5000` and converts
   values by column type in the browser. No new route.
6. A chart renders only when the whole output fits in 5,000 rows. Above that,
   the tab shows the row count and asks to aggregate upstream.
7. A chart merges as one unit: concurrent changes to the same chart conflict.
8. Charts are per component instance; they are not copied into the component
   definition.

## File format

`charts.json` maps a node output to a list of named charts. An entry has
exactly `name` (1 to 100 characters, unique per output) and `spec` (a
Vega-Lite 6 spec of at most 64 KiB when serialized). Duckpad metadata lives
beside the spec, never inside it: Vega-Lite has its own top-level `name`.

The Northstar example has this chart on the ranked output of the
Regional revenue instance:

```json
{
  "report::rank:result": [
    {
      "name": "Revenue by region",
      "spec": {
        "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
        "mark": "bar",
        "encoding": {
          "x": {"field": "region", "type": "nominal", "sort": "-y"},
          "y": {"field": "revenue", "type": "quantitative", "title": "Revenue"}
        }
      }
    }
  ]
}
```

- **Keys** follow the `views.json` rule. A key names the output that stores
  the rows: inside a component instance, `instance::node:port`, which is what
  grouping already writes for views and documentation. The Chart tab resolves
  the shown dataset to its stored output, so selecting the instance or its
  inner node shows the same charts.
- **`$schema`** is optional. When present it is a Vega-Lite 6 schema URL
  (`v6.json` or a `v6.x.y.json` variant). Duckpad pins one major version; a
  future major upgrade migrates project files.
- **`data`** is optional. When present it is exactly `{"name": "data"}`. The
  renderer always supplies the rows.

Specs copied from examples or written by language models usually include
`$schema` and `data`; accepting both keeps them pasteable.

## Validation

A `charts` module mirrors `views` and runs right after it in project
validation. An invalid file is still saved and committed, and reported as a
diagnostic. Full Vega-Lite validity and field existence are checked by the
renderer in the Chart tab, where the columns are known.

The allowlist, by level:

- **Top level:** `$schema`, `data`, `mark`, `encoding`, `layer`, `title`,
  `description`, `width`, `height`. `width` and `height` are a positive number
  or `"container"`. `title` is a string or an object with `text` and
  `subtitle` strings.
- **Layers:** each item of `layer` holds only `mark`, `encoding`, `title` and
  `description`.
- **Marks:** `bar`, `line`, `area`, `point`, `circle`, `square`, `tick`,
  `rect`, `rule`, `text`, `arc`. A mark is a type string or an object with
  `type` plus literal `color`, `opacity`, `filled`, `size`, `strokeWidth`,
  `interpolate`, `point`, `orient`, `tooltip`, `innerRadius`, `outerRadius`
  or `cornerRadius`. Composite and unknown marks are diagnostics.
- **Channels:** `x`, `y`, `x2`, `y2`, `xOffset`, `yOffset`, `theta`,
  `radius`, `color`, `fill`, `stroke`, `opacity`, `size`, `shape`,
  `strokeDash`, `text`, `tooltip`, `detail`, `order`. `tooltip` may be a list
  of channel definitions.
- **Channel definition:** `field` (string), `type` (`quantitative`,
  `temporal`, `ordinal`, `nominal`), `title` (string or `null`), `format`
  (string without quotes or backslashes, which Vega-Lite writes into an
  expression unescaped), `formatType` (`number` or `time`), `value` (literal),
  `scale`, `axis`, `legend`, `sort`, `stack`.
  - `sort`: `"ascending"`, `"descending"`, `null`, a channel name of this
    list with an optional `-` prefix, a list of literals, or
    `{"encoding", "order"}` with a channel name and `"ascending"`,
    `"descending"` or `null`. An object with `field` or `op` is a diagnostic.
  - `stack`: `true`, `false`, `null`, `"zero"` or `"center"`.
  - `scale`: `type`, `domain`, `range`, `scheme`, `zero`, `nice`, `reverse`.
    `axis`: `title`, `format`, `formatType`, `labelAngle`, `grid`, `orient`,
    `tickCount`. `legend`: `title`, `format`, `formatType`, `orient`. Values
    are literals; `domain` and `range` are lists of literals, and
    `format` and `formatType` follow the channel rules. `axis` and `legend` may
    also be `null`, which hides them.

A **literal** is a JSON scalar: a string, a number, a boolean or `null`. Any
object or list where the allowlist expects a literal (mark style properties,
`value`, the items of `domain`, `range` and a `sort` list, and the scale, axis
and legend properties) is a diagnostic, so `{"expr": …}` and other
expression or signal references never reach the renderer. This is the central
safety property of the allowlist.

A spec has a `mark` or a `layer`, and every layer has a `mark`: Vega-Lite's
error for a spec without one quotes the whole spec, rows included.

Beyond the allowlist, a spec is at most 64 KiB serialized as compact UTF-8
JSON. Each diagnostic names the chart, its output and the path of the first
construct refused, such as `encoding.x.aggregate is not allowed`.

What the allowlist leaves out, so reviewers can check it against Vega-Lite:
transforms, `aggregate`, `bin`, `timeUnit`, `impute`, composite marks
(`boxplot`, `errorbar`, `errorband`), `sort.op`, `stack: "normalize"`,
`datum`, `condition`, `params` and every expression property, `href` and
`url`, `datasets`, inline data, `config`, and facet, repeat and concat views
with their own sub-spec `data` (`values`, `sequence`, `graticule`). Each can
be allowed later on its own.

Charts whose output no longer exists are not reported, as for views: keys are
only checked to be well formed, and deleting a node prunes its charts.

## Rendering and security

Duckpad sends no Content-Security-Policy, and an invalid project file still
reaches readers' browsers through branches, Git pulls, ZIP imports and external
editors. Backend validation therefore cannot be the only barrier:

- **No chart while the file is invalid.** When any diagnostic names
  `charts.json`, the tab renders nothing and lists the diagnostics with a link
  to the file in the Code tab.
- **Every embed** uses `ast: true` (vega-embed 7.3 then evaluates expressions
  with `vega-interpreter`, generating no code), a Vega loader that rejects
  every network and file request, and `actions: false`.
- **Text tooltips:** vega-tooltip's default formatter writes HTML, escapes
  only `&` and `<`, and turns an `image` entry into an `<img>` whose source
  is a cell. Duckpad formats tooltips itself, as escaped text.
- **Pinned versions:** `vega` 6.4.0, `vega-lite` 6.5.0, `vega-embed` 7.3.0
  and `vega-interpreter` 2.3.2, all BSD-3-Clause. Vega's expression language
  has had several XSS advisories, including in `vega-interpreter` before
  2.2.1; upgrades are deliberate changes.

Rendering details:

- `vega-embed` is loaded with a dynamic `import()` when the Chart tab first
  opens; the main bundle does not grow.
- The SVG renderer, sufficient at 5,000 rows and testable.
- A base `config` built from the interface's CSS variables and rebuilt when
  the theme switches. Specs carry no `config`.
- `formatLocale` and `timeFormatLocale` follow the interface language
  (`fr-FR`, `pt-BR`, Vega's default for English), so axes and tooltips use
  local number and date formats.
- Width defaults to `"container"` unless the spec sets one.

## Data and values

The tab calls `GET /api/worktrees/{worktree}/preview/{node}` with
`limit=5000`, the shown port, the selected environment and the Data tab's
partition selection, and no sample, filter, search or order: a chart plots the
whole output. The endpoint already counts first, then returns typed columns,
validity, run, commit, errors and row ids. The tab keeps the row ids with the
rendered rows for click-to-explain later.

When `matched_count` is above 5,000 the tab renders nothing and shows the count
with a hint to aggregate upstream. A truncated or sampled line would look
complete. Previews and samples allow up to 10,000 rows elsewhere; 5,000 is a
rendering limit.

Preview values are JSON-safe rather than chart-ready: only `DECIMAL` arrives
as a string (`HUGEINT` is already a JSON number), non-finite floats arrive as
`"inf"`, `"-inf"` or `"nan"`, and dates and timestamps as ISO text. A browser
helper converts each column by its type:

| Column type | Chart value |
| --- | --- |
| Integer, floating point, `DECIMAL`, `HUGEINT` | Number. Precision loss is accepted for charts; `"inf"` and `"nan"` become `null`. |
| `DATE` | `Date` at local midnight of that day. |
| `TIMESTAMP` (and its `_S`, `_MS`, `_NS` variants) | `Date` with the same local wall-clock time, to the millisecond. |
| `TIMESTAMP WITH TIME ZONE` | `Date` at that instant, shown in the viewer's time zone. |
| `BOOLEAN` | Boolean. |
| Anything else (`TIME`, lists, structs, maps, blobs) | String; lists and structs as their JSON text. |

The `DATE` rule matters: Vega parses `"2024-01-01"` as UTC midnight and shows
it in local time, a day early west of UTC. A `TIMESTAMP` string without a time
zone is already parsed as local time.

## Chart tab

- **Gate:** the tab is shown whenever the node has output ports, like the Data
  tab.
- **Dataset:** like saved views, the tab follows the dataset shown in the
  results panel, inputs included, and shows that dataset's charts. A
  component instance output resolves to the output that stores its rows
  (`instance::node:port`), so the instance and its inner node show the same
  charts.
- **States** follow the Data tab: Stale badge, Run hint without a result,
  failed-run messages, partition selection.
- **Several charts:** a selector by name, styled like the views bar.
- **Empty state:** a short explanation. Users with the Editor role (and
  administrators) also get **Add a chart**, which saves a starter bar chart of
  the first two columns for this output (creating `charts.json` when the
  project has none) and opens the file in the Code tab. The Code tab only
  opens existing files, so this action is how a project gets its first chart
  from the interface. Readers, Operators and read-only branches such as Job
  results see the explanation only.
- **Normal save:** **Add a chart** writes to the project from the results
  panel through the normal project save, like saving a view: it creates one
  commit, the server refuses it without the save permission, and on a stale
  revision it reports the conflict and retains both versions for resolution.
- **Errors in the tab:** too many rows, Vega-Lite compile errors and fields
  that the result has no column for (Vega-Lite would draw them as empty marks
  without an error).
- **Appearance:** the theme config is rebuilt from the CSS variables when the
  interface switches between light and dark, and the number and date formats
  follow the interface language. Vega's locale is global, so English sets
  en-US back explicitly. The `fr-FR` and `pt-BR` definitions come from
  `d3-format` and `d3-time-format`, pinned at the versions Vega uses.
- **Draft Preview tab:** no charts.

## Git, components and comparison

- **Merge:** three-way, by output key then by chart name, as views do. Charts
  added to the same output on two branches both survive; when both branches
  create `charts.json`, the merge starts from an empty document. A dedicated
  rule in `merge.py` compares each chart as one value, so concurrent different
  edits, or a deletion against an edit, are one conflict resolved by choosing a
  side. Views keep their field-by-field merge.
- **Comparison and Git review:** each chart is an entity
  `chart/<node:port>/<name>`, labeled "Revenue by region chart of
  report::rank:result", with a JSON diff.
- **Components:** grouping rewrites chart keys to `instance::node:port`, and
  deleting a node or instance prunes its charts, as for views. Documentation
  is copied into a component definition; charts are not.

The name-keyed helpers of `views` (`by_name`, `from_names`, `prune`) and the
key pattern move into a shared module for per-output named documents. Every
place hard-wired to `views.json` handles `charts.json` too:

- `project_files.py`: register `charts.json`; the `views` merge strategy
  becomes a `named` strategy with a per-file choice of field-level or
  whole-entry merge.
- `merge.py`, `comparison.py`, `components.py`, `validation.py`.
- `projects.py`: the save that rewrites documentation and views after a
  deletion rewrites `charts.json` too.
- `frontend/src/conflicts.ts`: list entries of `charts.json` are addressed by
  `name`, like views.

## Alternatives considered

- **A chart node on the canvas.** Rejected: it would be a processing step with
  runs and staleness for something that is only presentation, exactly what
  saved views avoid.
- **A dedicated `chart-data` route with server-side conversion.** Rejected:
  the preview endpoint already counts, reads with the same parameters and
  returns typed columns and row ids. A new route would add a conversion
  contract and an access classification for no new capability.
- **A denylist of transforms and expressions.** Rejected: Vega-Lite
  aggregates and injects data through many more paths (composite marks,
  `impute`, `sort.op`, `stack: "normalize"`, sub-spec `data`, `datum`). An
  allowlist is smaller and fails closed.
- **Charts in `views.json`.** Rejected: views select rows, charts present
  them; separate files keep diffs, merges and validation readable.
- **Truncating or sampling large outputs.** Rejected for this step: a partial
  series looks complete. Downsampling such as M4 for long time series can come
  later as an explicit, labeled mode.

## Out of scope

A chart editor or **Save as chart** from the Data tab; assistant chart
rendering (in chat or server-side); downsampling; click-to-explain on marks;
interactive selections, parameters, expressions, transforms and spec `config`;
charts in the draft Preview tab; chart output from Jobs; dashboards; rendered
visual diffs in Git review.

## Sources

- Vega-Lite: [documentation](https://vega.github.io/vega-lite/docs/)
- Vega: [interpreter for CSP-restricted environments](https://vega.github.io/vega/usage/interpreter/), [security advisories](https://github.com/vega/vega/security/advisories)
- vega-embed: [options](https://github.com/vega/vega-embed#options)
