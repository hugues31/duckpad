import pytest
from helpers import pipeline, wait_run


# Constructs whose exact contributions test_trace.py asserts are not repeated here.
@pytest.mark.parametrize(
    ("query", "column", "expected"),
    [
        ("SELECT grp, AVG(value) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;", "total", 3),
        ("SELECT grp, MIN(value) AS total FROM {{ source }} GROUP BY grp ORDER BY grp;", "total", 1),
        (
            "SELECT category FROM {{ source }} INTERSECT SELECT category FROM {{ source }} WHERE id=1;",
            "category",
            3,
        ),
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
    ],
)
def test_extended_lineage_baseline(services, tmp_path, query, column, expected):
    worktree, preview, lineage = pipeline(services, tmp_path, query)
    result = lineage.explain(worktree, "dev", preview["id"], 0, column)
    assert result["complete"], result
    assert result["total"] == expected, result


def test_aggregate_pagination_is_independent_of_preview_limit(services, tmp_path):
    worktree, preview, lineage = pipeline(services, tmp_path, "SELECT SUM(value) AS total FROM {{ source }};")
    first = lineage.explain(worktree, "dev", preview["id"], 0, "total")
    second = lineage.explain(worktree, "dev", preview["id"], 0, "total", offset=5)
    assert first["complete"], first
    assert first["total"] == second["total"] == 9
    assert len(first["contributions"]) == 5
    assert len(second["contributions"]) == 4
    assert not {c["row"] for c in first["contributions"]} & {c["row"] for c in second["contributions"]}
    larger = lineage.explain(worktree, "dev", preview["id"], 0, "total", page_size=100)
    assert len(larger["contributions"]) == 9
    rows = lineage.explain(
        worktree,
        "dev",
        preview["id"],
        0,
        "total",
        rows_dataset=first["contributions"][0]["dataset"],
        page_size=100,
    )
    assert len(rows["rows"]) == rows["count"] == 9
    assert [c["name"] for c in rows["columns"]] == ["id", "grp", "value", "category"]


def test_mixed_window_keeps_current_row_and_each_full_operand(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services,
        tmp_path,
        "SELECT id, value / SUM(value) OVER () + AVG(value) OVER () AS share FROM {{ source }} ORDER BY id",
    )
    result = lineage.explain(worktree, "dev", preview["id"], 1, "share")
    assert result["complete"], result
    scalar, total, average = result["operands"]
    assert scalar["value"] == 20
    assert scalar["contributions"][0]["row"] == 1
    assert total["value"] == 380 and total["total"] == 9
    assert average["value"] == pytest.approx(380 / 9)
    assert "SUM" not in result["calculation"]["evaluated"]
    page = lineage.explain(worktree, "dev", preview["id"], 1, "share", operand=total["id"], offset=5)
    assert len(page["contributions"]) == 4
    assert page["value"] == result["value"]


def test_mixed_group_aggregates_keep_separate_contributions(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services,
        tmp_path,
        "SELECT grp, SUM(value) / COUNT(value) AS mean FROM {{ source }} GROUP BY grp ORDER BY grp",
    )
    result = lineage.explain(worktree, "dev", preview["id"], 0, "mean")
    assert result["complete"], result
    assert [p["value"] for p in result["operands"]] == [50, 3]
    assert result["calculation"]["evaluated"] == "50 / 3"


@pytest.mark.parametrize(
    ("query", "row"),
    [
        # A scalar subquery reads another relation: it is not an operand of the row.
        ("SELECT id, value / (SELECT SUM(value) FROM {{ source }}) AS d FROM {{ source }} ORDER BY id", 1),
        ("SELECT grp, SUM(value) * (SELECT COUNT(*) FROM {{ source }}) AS d FROM {{ source }} GROUP BY grp", 0),
        # A GROUP BY expression stays one operand.
        ("SELECT upper(grp) || COUNT(*) AS d FROM {{ source }} GROUP BY upper(grp) ORDER BY 1", 0),
        # Operands that the captured row cannot identify fall back to the whole expression.
        ("SELECT DISTINCT grp, value * 0 + SUM(value) OVER (PARTITION BY grp) AS d FROM {{ source }}", 0),
    ],
)
def test_operands_never_make_a_covered_expression_incomplete(services, tmp_path, query, row):
    worktree, preview, lineage = pipeline(services, tmp_path, query)
    result = lineage.explain(worktree, "dev", preview["id"], row, "d")
    assert result["complete"], result["warnings"]


def test_a_distinct_group_narrows_only_its_own_operand(services, tmp_path):
    worktree, preview, lineage = pipeline(
        services,
        tmp_path,
        "SELECT COUNT(DISTINCT category) * 100 + SUM(value) AS d FROM {{ source }}",
    )
    result = lineage.explain(worktree, "dev", preview["id"], 0, "d")
    distinct, total = result["operands"]
    assert distinct["kind"] == "distinct_groups" and distinct["total"] == 7
    assert total["total"] == 9
    group = distinct["groups"][0]["key"]
    page = lineage.explain(worktree, "dev", preview["id"], 0, "d", group=group, operand=distinct["id"])
    assert page["complete"], page["warnings"]
    assert page["total"] == distinct["groups"][0]["rows"]


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
