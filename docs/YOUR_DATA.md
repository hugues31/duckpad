# Use your own data

Load a file, check its columns, transform it and download a CSV. You need a
project you can edit and run (Editor or Project Admin access). If you have not
signed in yet, start with [installation](INSTALLATION.md); for an introduction
to SQL nodes, follow the [quickstart](QUICKSTART.md).

## Choose a source

| Your data is… | Start with | What you need |
| --- | --- | --- |
| A CSV, Parquet, JSON or XLSX file on your computer | Drop it onto the canvas, or choose the matching Load node | No connection; XLSX may need the `excel` extension |
| In a folder on the Duckpad server | A file node with a Server folder location | An instance admin must configure and grant the connection |
| In S3 or compatible storage | A file node with an S3 location | A granted connection configured for the selected environment |
| In a database | **Load table** | A granted database connection, then a schema and table |

**Project files** are uploaded to the Duckpad server. A path on your laptop is
not a path on a remote server. Upload the file, or ask an instance administrator
to configure a connection to storage the server can reach. See
[connections](CONNECTORS.md) for database setup, formats and permissions.

## 1. Upload and inspect a CSV

On **Projects**, choose **New project → Empty project**, give it a name and
choose **Create**. Keep **dev** selected for this example. Save this text as
`orders.csv` on your computer, or use your own CSV:

```csv
order_id,region,amount
001,Europe,120
002,Europe,30
003,North America,80
```

Drop the file onto the **Flow** canvas. Duckpad uploads it and creates a reader
node named after the file. You can also click **Load CSV**, leave **Location**
set to **Project files**, and choose **Upload file** in the inspector.

The inspector shows the first 20 rows before a run. Check the delimiter and
header settings. For this example, set the `order_id` column's data type to
`VARCHAR` to keep leading zeros. **Auto** uses DuckDB's detected type. Changing
the delimiter or header clears type overrides, so review them afterward.

Choose **Run all**, then select the node. **Results → Data** should show three
orders, with IDs `001`, `002` and `003`. A source preview in the inspector does
not publish a result; a run does.

Uploads are limited to 1 GiB per file. For larger files, ask an administrator
for a [Server folder connection](CONNECTORS.md#project-files-and-storage-locations).
For XLSX, select the sheet and check the [workbook limits](CONNECTORS.md#xlsx-workbooks).

## 2. Transform the rows

Drag **Select columns** from the palette onto the canvas. Connect the reader's output to its
`source` input, either by dragging between ports or using the inspector's input
selector. The upstream run makes column choices available.

Choose **Use all columns** to add `order_id`, `region` and `amount`. In the
`amount` row, change **Output name** to `revenue`.
Choose **Run with ancestors** on this node. Its Data tab should show
the same three orders with the new column name. For other operations, use
[Clean values](DATA_PREPARATION.md) or [write SQL](SQL.md).

Filters and samples in **Results → Data** only change the displayed rows. Use
a Filter node to change what downstream nodes and exports receive. You can
turn a sample filter into a node with **Add as a Filter node**.

## 3. Export and download

1. Drag **Export CSV** from the palette onto the canvas.
2. Connect the transformation's output to the export's `source` input.
3. Keep **Location → Project files**, set `destination` to `revenue.csv`, and
   choose the delimiter and header settings you want.
4. Choose **Run with ancestors** on the export. This reruns its upstream nodes
   and writes the full input table.
5. Open the export node's **Log** and choose **Download exported data**.

The download contains all three rows, including the `revenue` column. An export
has no output table, so its results panel opens on Log. A repeated CSV export
to the same destination replaces that file; a database **Export table** appends
rows instead. Check the selected environment before writing to shared storage.

The [results guide](RESULTS.md#download-exported-data) explains which exports
can be downloaded and when another export is required. For a custom query,
see [SQL exports](SQL.md#write-an-export).

## Keep and share the project

Completed edits are saved as Git commits. Use **Code → Download project ZIP**
to share the pipeline definition, without uploaded files, results or connections
([project files](AUTHORING.md#edit-and-share-project-files)).

Use **Download exported data** to share a result file, and
[project access](INSTALLATION.md#accounts-and-project-access) to let colleagues
work on the same server. A project ZIP is not an instance backup.

To refresh a source, upload and select its new file or update the connected
resource, then run again. Edits, file changes and environment switches do not
run the pipeline automatically. See [result lifetime](RESULTS.md#result-lifetime)
and [troubleshooting](TROUBLESHOOTING.md) if the displayed rows are unexpected.
