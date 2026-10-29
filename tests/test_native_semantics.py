import duckdb
import pytest
from helpers import pipeline

from duckpad.util import clean


@pytest.mark.parametrize(
    "query",
    [
        "SELECT category FROM {{ source }} WHERE grp='A' ORDER BY id;",
        "SELECT id, CAST(value / 3 AS DECIMAL(12,3)) AS amount, value > 20 AS eligible FROM {{ source }} ORDER BY id;",
        "SELECT COLUMNS('id|grp'), category FROM {{ source }} ORDER BY id;",
        "SELECT * EXCLUDE (grp), value * 2 AS doubled FROM {{ source }} ORDER BY id;",
        "SELECT * REPLACE (value * 2 AS value), grp AS other FROM {{ source }} ORDER BY id;",
        "SELECT a.*, b.category AS other FROM {{ source }} a LEFT JOIN {{ source }} b ON a.id=b.id+1 ORDER BY a.id;",
        "SELECT a.*, b.category AS other FROM {{ source }} a RIGHT JOIN {{ source }} b ON a.id=b.id+1 ORDER BY b.id;",
        "SELECT a.id, b.id AS other FROM {{ source }} a FULL JOIN {{ source }} b ON a.id=b.id+1 ORDER BY a.id NULLS LAST, b.id;",
        "SELECT category, COUNT(*) AS n FROM {{ source }} GROUP BY 1 ORDER BY 1;",
        "SELECT COUNT(*) AS n FROM {{ source }} GROUP BY id % 3 ORDER BY id % 3;",
        "SELECT id, SUM(value) OVER (PARTITION BY grp ORDER BY id ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS total FROM {{ source }} ORDER BY id;",
        "SELECT grp, SUM(SUM(value)) OVER (ORDER BY grp) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;",
        "SELECT DISTINCT category FROM {{ source }} ORDER BY category;",
        "SELECT category FROM {{ source }} UNION ALL SELECT category FROM {{ source }} ORDER BY category;",
        "SELECT category FROM {{ source }} INTERSECT SELECT category FROM {{ source }} WHERE id<4 ORDER BY category;",
        "SELECT category FROM {{ source }} EXCEPT SELECT category FROM {{ source }} WHERE id<4 ORDER BY category;",
        "WITH q AS (SELECT * FROM {{ source }} WHERE value>10) SELECT grp, MAX(value) AS total FROM q GROUP BY grp ORDER BY grp;",
        "SELECT a.* FROM {{ source }} a SEMI JOIN {{ source }} b ON a.id=b.id ORDER BY a.id;",
    ],
)
def test_instrumentation_preserves_native_values_types_and_multiplicity(services, tmp_path, query):
    _, preview, _ = pipeline(services, tmp_path, query)
    with duckdb.connect() as db:
        db.execute("CREATE TABLE source AS SELECT * FROM read_csv(?)", [str(tmp_path / "input.csv")])
        db.execute("CREATE TABLE expected AS " + query.replace("{{ source }}", "source"))
        schema = [{"name": c[0], "type": c[1]} for c in db.execute("DESCRIBE expected").fetchall()]
        expected = clean(db.execute("SELECT * FROM expected").fetchall())
    assert preview["columns"] == schema
    assert [r["values"] for r in preview["rows"]] == expected
