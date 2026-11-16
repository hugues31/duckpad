"""SQL templates available in every new project."""

BUILTINS = {
    "load_csv": """-- @label Load CSV
-- @icon spreadsheet
-- @description Read a CSV resource using native DuckDB options.
-- @param connection: connection = ""
-- @param file: file(connection) = ""
-- @param delimiter: text = ","
-- @param header: boolean = true
-- @param types: schema = {}
-- @output result
SELECT * FROM read_csv({{ file }}, delim={{ delimiter }}, header={{ header }}, types={{ types }});
""",
    "load_parquet": """-- @label Load Parquet
-- @icon layers
-- @description Read a Parquet file, keeping its columns and types.
-- @param connection: connection = ""
-- @param file: file(connection) = ""
-- @output result
SELECT * FROM read_parquet({{ file }});
""",
    "load_xlsx": """-- @label Load XLSX
-- @icon table
-- @description Read an XLSX worksheet. Leave sheet blank to use the first sheet; all_varchar preserves mixed columns as text.
-- @param connection: connection = ""
-- @param file: file(connection) = ""
-- @param sheet: text = ""
-- @param header: boolean = true
-- @param all_varchar: boolean = false
-- @output result
SELECT * FROM read_xlsx({{ file }}, sheet={{ sheet }}, header={{ header }}, all_varchar={{ all_varchar }});
""",
    "load_json": """-- @label Load JSON
-- @icon json
-- @description Read JSON or newline-delimited JSON from project files.
-- @param connection: connection = ""
-- @param file: file(connection) = ""
-- @output result
SELECT * FROM read_json_auto({{ file }});
""",
    "load_delta": """-- @label Load Delta
-- @icon history
-- @description Read the current version of a Delta Lake table folder with DuckDB's delta extension.
-- @param connection: connection = ""
-- @param table: file(connection) = ""
-- @output result
SELECT * FROM delta_scan({{ table }});
""",
    "load_table": """-- @label Load table
-- @icon database
-- @description Read a table or view of a database connection.
-- @param connection: connection = ""
-- @param schema: schema_name(connection) = "public"
-- @param table: table_name(schema) = ""
-- @output result
SELECT * FROM {{ connection }}.{{ schema }}.{{ table }};
""",
    "join": """-- @label Join
-- @icon join
-- @description Combine the rows of two inputs that satisfy a condition. Choose key pairs and a join type. Unmatched outer rows contain nulls; repeated keys multiply matches. Right column collisions receive a right_ prefix. SQL aliases are l and r.
-- @input left
-- @input right
-- @param join_type: keyword(inner|left|right|full) = "inner"
-- @param condition: join_keys(left,right) = []
-- @param columns: joined_columns(left,right) = "all"
-- @output result
SELECT {{ columns }} FROM {{ left }} AS l {{ join_type }} JOIN {{ right }} AS r ON {{ condition }};
""",
    "filter": """-- @label Filter
-- @icon filter
-- @description Keep the rows that match a condition.
-- @input source
-- @param condition: conditions(source) = {"mode":"and","conditions":[]}
-- @output result
SELECT * FROM {{ source }} WHERE {{ condition }};
""",
    "select_columns": """-- @label Select columns
-- @icon columns
-- @description Keep, rename, reorder and convert columns. Invalid conversions fail without replacing previous results.
-- @input source
-- @param columns: column_selection(source) = []
-- @output result
SELECT {{ columns }} FROM {{ source }};
""",
    "clean_values": """-- @label Clean values
-- @icon clean
-- @description Trim text, parse dates, then fill nulls in the resulting type. Other columns are preserved.
-- @input source
-- @param columns: value_cleaning(source) = []
-- @output result
SELECT {{ columns }} FROM {{ source }};
""",
    "aggregate": """-- @label Aggregate
-- @icon aggregate
-- @description Group the rows and compute one row of measures per group.
-- @input source
-- @param groups: group_columns(source) = []
-- @param measures: measures(source) = [{"function":"COUNT","column":"*","alias":"rows"}]
-- @output result
SELECT {{ groups }}{{ measures }} FROM {{ source }} GROUP BY ALL;
""",
    "export_csv": """-- @label Export CSV
-- @icon export
-- @description Write a CSV file, replacing the destination on each run.
-- @input source
-- @param connection: connection = ""
-- @param destination: destination(connection) = "export.csv"
-- @param delimiter: text = ","
-- @param header: boolean = true
COPY {{ source }} TO {{ destination }} (FORMAT CSV, HEADER {{ header }}, DELIMITER {{ delimiter }});
""",
    "export_xlsx": """-- @label Export XLSX
-- @icon file
-- @description Write a single-sheet XLSX workbook, replacing the destination on each run.
-- @input source
-- @param connection: connection = ""
-- @param destination: destination(connection) = "export.xlsx"
-- @param sheet: text = "Sheet1"
-- @param header: boolean = true
COPY {{ source }} TO {{ destination }} (FORMAT XLSX, SHEET {{ sheet }}, HEADER {{ header }});
""",
    "export_table": """-- @label Export table
-- @icon upload
-- @description Insert the rows into an existing table of a database connection, matching columns by name. Nothing is truncated or created.
-- @input source
-- @param connection: connection = ""
-- @param schema: schema_name(connection) = "public"
-- @param table: table_name(schema) = ""
INSERT INTO {{ connection }}.{{ schema }}.{{ table }} BY NAME SELECT * FROM {{ source }};
""",
    "export_oracle": """-- @label Export Oracle
-- @icon server
-- @description Insert the selected columns into an existing Oracle table. Nothing is truncated or created.
-- @input source
-- @param connection: connection = "oracle"
-- @param secret: secret(connection) = ""
-- @param destination: text = "DEMO.ORDER_TOTALS"
-- @param columns: expressions = "*"
COPY (SELECT {{ columns }} FROM {{ source }}) TO {{ destination }} (FORMAT oraduck, CONNECTION {{ secret }});
""",
    "sql": """-- @label SQL transform
-- @icon sql
-- @description A reusable SQL template with named ports and typed parameters.
-- @input source
-- @output result
SELECT * FROM {{ source }};
""",
    "union": """-- @label Union
-- @icon union
-- @description Append two inputs. ALL BY NAME aligns column names, fills missing columns with nulls and preserves duplicates. ALL aligns by position; BY NAME removes duplicates. DuckDB resolves compatible types; incompatible types fail. Example: [1,2] plus [2,3] keeps four rows with ALL. BY NAME cell lineage is currently incomplete.
-- @input left
-- @input right
-- @param mode: keyword(ALL BY NAME|BY NAME|ALL|DISTINCT) = "ALL BY NAME"
-- @output result
SELECT * FROM {{ left }} UNION {{ mode }} SELECT * FROM {{ right }};
""",
    "sort": """-- @label Sort
-- @icon sort
-- @description Order rows by one or more columns with explicit direction and null placement. Add a unique final key for stable ties. Example: amount descending puts the largest amount first, with nulls last.
-- @input source
-- @param order: ordering(source) = []
-- @output result
SELECT * FROM {{ source }} ORDER BY {{ order }};
""",
    "deduplicate": """-- @label Deduplicate
-- @icon deduplicate
-- @description Keep the first row per key combination in the configured order. Null keys form one group. Add a unique final sort key to decide ties. Example: key customer_id, order order_id descending keeps each customer's latest order. QUALIFY cell lineage is currently incomplete.
-- @input source
-- @param keys: columns(source) = []
-- @param order: ordering(source) = []
-- @output result
SELECT * FROM {{ source }} QUALIFY ROW_NUMBER() OVER (PARTITION BY {{ keys }} ORDER BY {{ order }}) = 1;
""",
    "calculate": """-- @label Calculated columns
-- @icon formula
-- @description Append SQL expressions with unique output names. Existing columns are preserved. Example: amount * 1.2 AS gross_amount changes 10 into 12. Nulls follow each expression's SQL semantics.
-- @input source
-- @param calculations: expressions = ""
-- @output result
SELECT *, {{ calculations }} FROM {{ source }};
""",
    "pivot": """-- @label Pivot
-- @icon pivot
-- @description Turn an explicit list of category values into columns and aggregate repeated group/category pairs. Without groups, one row aggregates the whole input. Unlisted categories are excluded; missing SUM groups produce nulls. Example: group region, category channel, value amount, categories Web/Retail sums each channel per region.
-- @input source
-- @param groups: group_columns(source) = []
-- @param category: column(source) = ""
-- @param value: column(source) = ""
-- @param categories: list<text> = []
-- @param function: keyword(SUM|AVG|MIN|MAX|COUNT) = "SUM"
-- @output result
SELECT * FROM (SELECT {{ groups }}{{ category }}, {{ value }} FROM {{ source }}) PIVOT ({{ function }}({{ value }}) FOR {{ category }} IN ({{ categories }}));
""",
    "unpivot": """-- @label Unpivot
-- @icon unpivot
-- @description Turn selected columns into name/value rows, retaining null values and all other columns. Selected columns must have compatible types. Example: Web=10, Retail=NULL becomes (Web,10) and (Retail,NULL).
-- @input source
-- @param columns: columns(source) = []
-- @param name: identifier = "category"
-- @param value: identifier = "value"
-- @output result
SELECT * FROM {{ source }} UNPIVOT INCLUDE NULLS ({{ value }} FOR {{ name }} IN ({{ columns }}));
""",
    "sample": """-- @label Sample
-- @icon sample
-- @description Reproducible approximate percentage using MD5 of a key and seed. The same key (including null) is always kept or excluded together. Use a unique nonnull key for independent rows. Independent of input order; 0 keeps none and 100 keeps all. Example: order_id, 10 percent, seed 42.
-- @input source
-- @param key: column(source) = ""
-- @param percent: number = 10
-- @param seed: text = "42"
-- @output result
SELECT * FROM {{ source }} WHERE CASE WHEN {{ percent }} BETWEEN 0 AND 100 THEN md5_number_lower(to_json(struct_pack(seed := {{ seed }}, key := {{ key }}))) % 10000 < {{ percent }} * 100 ELSE error('Sample percent must be between 0 and 100') END;
""",
    "rank": """-- @label Rank
-- @icon number
-- @description Rank rows within key groups in the selected order. Equal ordering values share a rank and leave gaps. Null keys form a group. Without groups, the whole input is ranked. Example: partition region, amount descending ranks the largest sale first.
-- @input source
-- @param groups: group_columns(source) = []
-- @param order: ordering(source) = []
-- @param name: identifier = "rank"
-- @output result
SELECT *, RANK() OVER (PARTITION BY {{ groups }}NULL ORDER BY {{ order }}) AS {{ name }} FROM {{ source }};
""",
    "running_total": """-- @label Running total
-- @icon window
-- @description Sum a numeric value from the first row to the current row in each key group. Null values are ignored. Use a unique final order key to decide ties. Without groups, the total runs over the whole input. Example: region, order_id ascending, amount gives cumulative regional sales.
-- @input source
-- @param groups: group_columns(source) = []
-- @param order: ordering(source) = []
-- @param value: column(source) = ""
-- @param name: identifier = "running_total"
-- @output result
SELECT *, SUM({{ value }}) OVER (PARTITION BY {{ groups }}NULL ORDER BY {{ order }} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS {{ name }} FROM {{ source }};
""",
    "export_parquet": """-- @label Export Parquet
-- @icon download
-- @description Write a Parquet file with its column types and nulls, replacing the destination on every run. Example: export.parquet with ZSTD compression.
-- @input source
-- @param connection: connection = ""
-- @param destination: destination(connection) = "export.parquet"
-- @param compression: keyword(ZSTD|SNAPPY|UNCOMPRESSED) = "ZSTD"
COPY {{ source }} TO {{ destination }} (FORMAT PARQUET, COMPRESSION {{ compression }});
""",
}
