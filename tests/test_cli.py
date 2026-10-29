"""Startup failures should be actionable without modifying an old instance."""

import sqlite3
import subprocess
import sys
from contextlib import closing


def test_legacy_schema_startup_reports_new_home_without_traceback(tmp_path):
    path = tmp_path / "instance.sqlite"
    with closing(sqlite3.connect(path)) as connection, connection:
        connection.execute("CREATE TABLE records (kind TEXT, id TEXT, value TEXT)")
        connection.execute("INSERT INTO records VALUES ('settings', 'marker', 'kept')")
    result = subprocess.run(
        [sys.executable, "-m", "duckpad", "start", "--home", str(tmp_path), "--no-browser"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode != 0
    assert "unsupported document schema" in result.stderr
    assert "duckpad start --home <new-directory>" in result.stderr
    assert "Traceback" not in result.stderr
    with closing(sqlite3.connect(path)) as connection:
        assert connection.execute("SELECT value FROM records").fetchall() == [("kept",)]
        assert connection.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall() == [
            ("records",)
        ]
