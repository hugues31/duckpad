import pytest
from conftest import wait_run

from duckpad.lineage import Lineage


def pipeline(services, tmp_path, query):
    store, projects, _, engine = services
    source = tmp_path / "input.csv"
    source.write_text(
        "id,grp,value,category\n1,A,10,X\n2,A,20,X\n3,A,20,Y\n4,B,30,Z\n5,B,40,Z\n6,B,50,W\n7,B,60,V\n8,B,70,U\n9,B,80,T\n"
    )
    bundle = {
        "flow": {
            "nodes": [
                {"id": "source", "template": "source", "params": {"file": str(source)}},
                {"id": "query", "template": "query", "params": {}},
            ],
            "edges": [
                {
                    "id": "edge",
                    "source": "source",
                    "sourceHandle": "result",
                    "target": "query",
                    "targetHandle": "source",
                }
            ],
        },
        "templates": {
            "source": "-- @kind source\n-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});",
            "query": "-- @input source\n-- @output result\n" + query,
        },
        "components": {},
        "documentation": {},
    }
    worktree = projects.create("Lineage", bundle)["id"]
    run = wait_run(store, engine.launch(worktree, "dev"))
    assert run["status"] == "success", run
    preview = engine.preview(worktree, "dev", "query")
    return worktree, preview, Lineage(engine)


@pytest.mark.parametrize(
    "query,column,expected",
    [
        ("SELECT id, value * 2 AS doubled FROM {{ source }} WHERE id = 1;", "doubled", 1),
        (
            "SELECT a.id, a.value + b.value AS total FROM {{ source }} a JOIN {{ source }} b ON a.id=b.id WHERE a.id=1;",
            "total",
            1,
        ),
        ("SELECT grp, SUM(value) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;", "total", 3),
        ("SELECT grp, AVG(value) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;", "total", 3),
        ("SELECT grp, MIN(value) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;", "total", 1),
        ("SELECT grp, MAX(value) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;", "total", 2),
        ("SELECT grp, COUNT(*) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;", "total", 3),
        ("SELECT DISTINCT category FROM {{ source }} ORDER BY category;", "category", 1),
        (
            "SELECT id, SUM(value) OVER (PARTITION BY grp ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS total FROM {{ source }} ORDER BY id;",
            "total",
            1,
        ),
        (
            "SELECT id, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY id) AS rank FROM {{ source }} ORDER BY id;",
            "rank",
            3,
        ),
        (
            "SELECT category FROM {{ source }} WHERE id<3 UNION SELECT category FROM {{ source }} WHERE id=3 ORDER BY category;",
            "category",
            2,
        ),
        (
            "SELECT category FROM {{ source }} INTERSECT SELECT category FROM {{ source }} WHERE id=1;",
            "category",
            3,
        ),
        (
            "SELECT category FROM {{ source }} WHERE id<4 EXCEPT SELECT category FROM {{ source }} WHERE id=1;",
            "category",
            1,
        ),
        (
            "WITH filtered AS (SELECT * FROM {{ source }} WHERE grp='A') SELECT SUM(value) AS total FROM filtered;",
            "total",
            3,
        ),
        ("SELECT SUM(value) AS total FROM (SELECT * FROM {{ source }} WHERE grp='A') filtered;", "total", 3),
        ("SELECT id, MAX(value) OVER (PARTITION BY grp) AS total FROM {{ source }} ORDER BY id;", "total", 2),
        ("SELECT id, MIN(value) OVER (PARTITION BY grp) AS total FROM {{ source }} ORDER BY id;", "total", 1),
        (
            "SELECT id, FIRST_VALUE(value) OVER (PARTITION BY grp ORDER BY id) AS total FROM {{ source }} ORDER BY id;",
            "total",
            1,
        ),
        (
            "SELECT id, LEAD(value) OVER (PARTITION BY grp ORDER BY id) AS total FROM {{ source }} ORDER BY id;",
            "total",
            1,
        ),
        (
            "SELECT grp, SUM(SUM(value)) OVER (ORDER BY grp) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;",
            "total",
            1,
        ),
        ("SELECT SUM(value) FILTER (WHERE id > 1) AS total FROM {{ source }} WHERE grp='A';", "total", 2),
    ],
)
def test_extended_lineage_baseline(services, tmp_path, query, column, expected):
    worktree, preview, lineage = pipeline(services, tmp_path, query)
    result = lineage.explain(worktree, "dev", preview["id"], 0, column)
    assert result["complete"], result
    assert result["total"] == expected, result


def test_distinct_count_keeps_duplicate_cells_and_both_pagination_levels(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services,
        tmp_path,
        "SELECT grp, COUNT(DISTINCT category) AS customers FROM {{ source }} GROUP BY grp ORDER BY grp;",
    )
    result = lineage.explain(worktree, "dev", preview["id"], 0, "customers")
    assert result["complete"], result
    assert result["total"] == 2
    assert result["groups"][0]["value"] == "X"
    assert result["groups"][0]["rows"] == 2
    group = lineage.explain(worktree, "dev", preview["id"], 0, "customers", group=result["groups"][0]["key"])
    assert group["total"] == 2
    assert [c["row"] for c in group["contributions"]] == [0, 1]
    second = lineage.explain(worktree, "dev", preview["id"], 1, "customers", offset=5)
    assert second["total"] == 5
    assert not second["groups"]


def test_aggregate_pagination_is_independent_of_preview_limit(services, tmp_path):
    worktree, preview, lineage = pipeline(services, tmp_path, "SELECT SUM(value) AS total FROM {{ source }};")
    first = lineage.explain(worktree, "dev", preview["id"], 0, "total")
    second = lineage.explain(worktree, "dev", preview["id"], 0, "total", offset=5)
    assert first["complete"], first
    assert first["total"] == second["total"] == 9
    assert len(first["contributions"]) == 5
    assert len(second["contributions"]) == 4
    assert not {c["row"] for c in first["contributions"]} & {c["row"] for c in second["contributions"]}


def test_equal_projection_values_keep_distinct_row_witnesses(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services, tmp_path, "SELECT category FROM {{ source }} WHERE grp='A' ORDER BY id;"
    )
    first = lineage.explain(worktree, "dev", preview["id"], 0, "category")
    second = lineage.explain(worktree, "dev", preview["id"], 1, "category")
    assert first["complete"] and second["complete"], (first, second)
    assert first["value"] == second["value"] == "X"
    assert first["total"] == second["total"] == 1
    assert first["contributions"][0]["row"] == 0
    assert second["contributions"][0]["row"] == 1


def test_unselected_group_keys_distinguish_equal_aggregate_results(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services, tmp_path, "SELECT COUNT(*) AS n FROM {{ source }} GROUP BY id % 3 ORDER BY id % 3;"
    )
    results = [lineage.explain(worktree, "dev", preview["id"], row["id"], "n") for row in preview["rows"]]
    assert all(result["complete"] and result["total"] == 3 for result in results), results
    identities = [{item["row"] for item in result["contributions"]} for result in results]
    assert identities[0].isdisjoint(identities[1]) and identities[1].isdisjoint(identities[2])


def test_user_rowid_column_does_not_replace_stable_storage_identity(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services, tmp_path, "SELECT 99 AS rowid, category FROM {{ source }} WHERE grp='A' ORDER BY id;"
    )
    assert [r["id"] for r in preview["rows"]] == [0, 1, 2]
    assert [r["values"][0] for r in preview["rows"]] == [99, 99, 99]
    result = lineage.explain(worktree, "dev", preview["id"], 1, "category")
    assert result["complete"] and result["total"] == 1, result
    assert result["contributions"][0]["row"] == 1


def test_distinct_window_groups_retain_duplicate_cell_identity(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services,
        tmp_path,
        "SELECT id, COUNT(DISTINCT category) OVER (PARTITION BY grp) AS n FROM {{ source }} ORDER BY id;",
    )
    result = lineage.explain(worktree, "dev", preview["id"], 0, "n")
    assert result["complete"] and result["kind"] == "distinct_groups", result
    assert result["total"] == 2 and result["groups"][0]["rows"] == 2
    group = lineage.explain(worktree, "dev", preview["id"], 0, "n", group=result["groups"][0]["key"])
    assert group["total"] == 2, group
    assert {c["row"] for c in group["contributions"]} == {0, 1}


def test_distinct_count_pages_more_than_five_groups_and_duplicate_rows(services, tmp_path):
    from conftest import wait_run

    worktree, _, lineage = pipeline(
        services, tmp_path, "SELECT COUNT(DISTINCT category) AS n FROM {{ source }};"
    )
    source = tmp_path / "input.csv"
    values = ["A"] * 7 + list("BCDEFGH")
    source.write_text("id,grp,value,category\n" + "".join(f"{i},G,{i},{v}\n" for i, v in enumerate(values)))
    store, _, _, engine = services
    assert wait_run(store, engine.launch(worktree, "dev"))["status"] == "success"
    preview = engine.preview(worktree, "dev", "query")
    first = lineage.explain(worktree, "dev", preview["id"], 0, "n")
    next_groups = lineage.explain(worktree, "dev", preview["id"], 0, "n", offset=5)
    assert first["total"] == next_groups["total"] == 8
    assert len(first["groups"]) == 5 and len(next_groups["groups"]) == 3
    group = first["groups"][0]
    assert group["rows"] == 7
    cells = lineage.explain(worktree, "dev", preview["id"], 0, "n", group=group["key"])
    next_cells = lineage.explain(worktree, "dev", preview["id"], 0, "n", group=group["key"], offset=5)
    assert cells["total"] == next_cells["total"] == 7
    assert len(cells["contributions"]) == 5 and len(next_cells["contributions"]) == 2
    assert {c["row"] for c in cells["contributions"]}.isdisjoint(
        c["row"] for c in next_cells["contributions"]
    )
