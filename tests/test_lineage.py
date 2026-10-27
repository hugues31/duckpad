import pytest
from helpers import pipeline, wait_run


@pytest.mark.parametrize(
    ("query", "column", "expected"),
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
    from helpers import pipeline

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


@pytest.mark.parametrize("value", ["'ab'::BLOB", "INTERVAL 1 DAY", "MAP {'key': 1}"])
def test_rows_with_values_that_have_no_sql_literal_are_explained(services, tmp_path, value):
    worktree, preview, lineage = pipeline(
        services, tmp_path, f"SELECT id, {value} AS extra FROM {{{{ source }}}} WHERE grp='A' ORDER BY id;"
    )
    result = lineage.explain(worktree, "dev", preview["id"], 1, "id")
    assert result["complete"], result
    assert [c["row"] for c in result["contributions"]] == [1]


def test_binary_group_keys_are_explained(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services,
        tmp_path,
        "SELECT CAST(grp AS BLOB) AS grp, SUM(value) AS total FROM {{ source }} GROUP BY 1 ORDER BY 1;",
    )
    result = lineage.explain(worktree, "dev", preview["id"], 0, "total")
    assert result["complete"], result
    assert result["total"] == 3


@pytest.mark.parametrize(
    ("query", "passthrough", "evaluated", "value"),
    [
        ("SELECT value AS result FROM {{ source }} WHERE id=1", True, "10", 10),
        ("SELECT value * 1 AS result FROM {{ source }} WHERE id=1", False, "10 * 1", 10),
        ("SELECT value * 2 + id AS result FROM {{ source }} WHERE id=1", False, "10 * 2 + 1", 21),
        ("SELECT 0 AS result FROM {{ source }} WHERE id=1", False, "0", 0),
    ],
)
def test_calculation_description_uses_the_expression_and_captured_operands(
    services, tmp_path, query, passthrough, evaluated, value
):
    worktree, preview, lineage = pipeline(services, tmp_path, query)
    result = lineage.explain(worktree, "dev", preview["id"], 0, "result")
    assert result["complete"], result
    assert result["value"] == value
    assert result["calculation"]["passthrough"] is passthrough
    assert result["calculation"]["evaluated"] == evaluated


def test_aggregate_description_does_not_present_one_page_as_the_whole_calculation(services, tmp_path):
    worktree, preview, lineage = pipeline(services, tmp_path, "SELECT SUM(value) AS total FROM {{ source }}")
    result = lineage.explain(worktree, "dev", preview["id"], 0, "total")
    assert result["total"] == 9 and len(result["contributions"]) == 5
    assert result["calculation"] == {"operation": "sum", "formula": "SUM(value)", "passthrough": False}


def test_compound_aggregate_does_not_claim_to_sum_the_raw_input_values(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services, tmp_path, "SELECT SUM(value * 2) AS total FROM {{ source }} WHERE grp='A'"
    )
    result = lineage.explain(worktree, "dev", preview["id"], 0, "total")
    assert result["value"] == 100
    assert result["calculation"] == {
        "operation": "expression",
        "formula": "SUM(value * 2)",
        "passthrough": False,
        "selection": ["grp = 'A'"],
    }


def test_self_join_operands_use_the_captured_side_instead_of_matching_values(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services,
        tmp_path,
        "SELECT a.value - b.value AS difference FROM {{ source }} a JOIN {{ source }} b ON b.id=a.id+1 WHERE a.id=1",
    )
    result = lineage.explain(worktree, "dev", preview["id"], 0, "difference")
    assert result["complete"], result
    assert result["value"] == -10
    assert result["calculation"]["formula"] == "a.value - b.value"
    assert result["calculation"]["evaluated"] == "10 - 20"


def test_group_selection_is_read_from_the_executed_row(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services, tmp_path, "SELECT grp, SUM(value) AS total FROM {{ source }} GROUP BY grp ORDER BY grp"
    )
    first = lineage.explain(worktree, "dev", preview["id"], 0, "total")
    second = lineage.explain(worktree, "dev", preview["id"], 1, "total")
    assert first["calculation"]["selection"] == ["grp = 'A'"]
    assert second["calculation"]["selection"] == ["grp = 'B'"]
