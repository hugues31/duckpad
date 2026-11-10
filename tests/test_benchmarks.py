"""Keep the opt-in benchmark entry points compatible with the execution service."""

import json
import subprocess
import sys

import pytest


@pytest.mark.parametrize("script", ["benchmark.py", "benchmark_scaling.py"])
def test_benchmark_entry_points_validate_small_fixture(tmp_path, script):
    output = tmp_path / "result.json"
    command = [sys.executable, "scripts/" + script, "--rows", "10000", "--output", str(output)]
    if script == "benchmark_scaling.py":
        command += ["--repeats", "1"]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=90, check=False)
    assert completed.returncode == 0, completed.stderr + completed.stdout
    result = json.loads(output.read_text())
    if script == "benchmark.py":
        assert result["native_value_comparison"] == "passed"
        assert result["lineage_total_contributions"] == 1500
    else:
        assert result["status"] == "passed" and not result["postgres_enabled"]
        assert len(result["results"]) == 1
        sample = result["results"][0]["samples"][0]
        assert sample["correctness"] == "passed"
        # Independent row-by-row oracle for Region 0, duplicate dimension keys and NULL exclusion.
        expected = sum(2 if row % 10000 < 2000 else 1 for row in range(10000) if row % 8 == 0 and row % 97)
        assert sample["lineage_contributions"] == expected
        assert sample["profiles"]["lineage_sql"]["contributions_count"]
        assert sample["profiles"]["lineage_python"]
