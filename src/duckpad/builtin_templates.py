"""SQL templates available in every new project."""

BUILTINS = {
    "load_csv": """-- @label Load CSV
-- @description Read a CSV resource using native DuckDB options.
-- @kind source
-- @param connection: connection = ""
-- @param file: file(connection) = "orders.csv"
-- @param delimiter: text = ","
-- @param header: boolean = true
-- @param types: schema = {}
-- @output result
SELECT * FROM read_csv({{ file }}, delim={{ delimiter }}, header={{ header }}, types={{ types }});
""",
    "load_parquet": """-- @label Load Parquet
-- @kind source
-- @param connection: connection = ""
-- @param file: file(connection) = "customers.parquet"
-- @output result
SELECT * FROM read_parquet({{ file }});
""",
    "load_xlsx": """-- @label Load XLSX
-- @description Read an XLSX worksheet. Leave sheet blank to use the first sheet; all_varchar preserves mixed columns as text.
-- @kind source
-- @param connection: connection = ""
-- @param file: file(connection) = "workbook.xlsx"
-- @param sheet: text = ""
-- @param header: boolean = true
-- @param all_varchar: boolean = false
-- @output result
SELECT * FROM read_xlsx({{ file }}, sheet={{ sheet }}, header={{ header }}, all_varchar={{ all_varchar }});
""",
    "load_oracle": """-- @label Load Oracle
-- @kind source
-- @param connection: connection = "oracle"
-- @param schema: identifier = "DEMO"
-- @param resource: identifier = "ORDERS"
-- @output result
SELECT * FROM {{ connection }}.{{ schema }}.{{ resource }};
""",
    "join": """-- @label Join
-- @input left
-- @input right
-- @param join_type: keyword(inner|left|right|full) = "inner"
-- @param condition: expression = "l.customer_id = r.customer_id"
-- @param columns: expressions = "l.*, r.* EXCLUDE (customer_id)"
-- @output result
SELECT {{ columns }} FROM {{ left }} AS l {{ join_type }} JOIN {{ right }} AS r ON {{ condition }};
""",
    "filter": """-- @label Filter
-- @input source
-- @param condition: expression(source) = "amount > 0"
-- @output result
SELECT * FROM {{ source }} WHERE {{ condition }};
""",
    "select_columns": """-- @label Select columns
-- @description Keep, rename, reorder and convert columns. Invalid conversions fail without replacing previous results.
-- @input source
-- @param columns: column_selection(source) = []
-- @output result
SELECT {{ columns }} FROM {{ source }};
""",
    "clean_values": """-- @label Clean values
-- @description Trim text, parse dates, then fill nulls in the resulting type. Other columns are preserved.
-- @input source
-- @param columns: value_cleaning(source) = []
-- @output result
SELECT {{ columns }} FROM {{ source }};
""",
    "aggregate": """-- @label Aggregate
-- @input source
-- @param groups: expressions = "region"
-- @param measures: expressions = "SUM(amount) AS revenue, COUNT(*) AS orders"
-- @output result
SELECT {{ groups }}, {{ measures }} FROM {{ source }} GROUP BY {{ groups }};
""",
    "export_csv": """-- @label Export CSV
-- @kind export
-- @input source
-- @param connection: connection = ""
-- @param destination: destination(connection) = "export.csv"
-- @param delimiter: text = ","
-- @param header: boolean = true
COPY {{ source }} TO {{ destination }} (FORMAT CSV, HEADER {{ header }}, DELIMITER {{ delimiter }});
""",
    "export_xlsx": """-- @label Export XLSX
-- @description Write a single-sheet XLSX workbook, replacing the destination on each run.
-- @kind export
-- @input source
-- @param connection: connection = ""
-- @param destination: destination(connection) = "export.xlsx"
-- @param sheet: text = "Sheet1"
-- @param header: boolean = true
COPY {{ source }} TO {{ destination }} (FORMAT XLSX, SHEET {{ sheet }}, HEADER {{ header }});
""",
    "export_oracle": """-- @label Export Oracle
-- @kind export
-- @input source
-- @param connection: connection = "oracle"
-- @param secret: secret(connection) = ""
-- @param destination: text = "DEMO.ORDER_TOTALS"
-- @param columns: expressions = "*"
COPY (SELECT {{ columns }} FROM {{ source }}) TO {{ destination }} (FORMAT oraduck, CONNECTION {{ secret }});
""",
    "sql": """-- @label SQL transform
-- @description A reusable SQL template with named ports and typed parameters.
-- @input source
-- @output result
SELECT * FROM {{ source }};
""",
}
