"""Artifact identity must use consistent metadata when capturing and opening files."""

from pathlib import Path
from types import SimpleNamespace

import pytest


def test_capture_and_download_use_descriptor_metadata(services, tmp_path, monkeypatch):
    store, projects, _, engine = services
    worktree = projects.create("Artifact metadata")
    artifacts = engine.exports.artifacts
    source = tmp_path / "report.csv"
    source.write_bytes(b"value\n42\n")
    original = Path.stat

    def path_metadata(path, *args, **kwargs):
        info = original(path, *args, **kwargs)
        if path.parent == artifacts.directory and kwargs.get("follow_symlinks", True):
            # Windows can report creation time via stat and change time via fstat.
            return SimpleNamespace(
                st_dev=info.st_dev,
                st_ino=info.st_ino,
                st_size=info.st_size,
                st_mtime_ns=info.st_mtime_ns,
                st_ctime_ns=info.st_ctime_ns + 1,
            )
        return info

    monkeypatch.setattr(Path, "stat", path_metadata)
    run = {
        "id": "run_test",
        "project": worktree["project"],
        "worktree": worktree["id"],
        "environment": "dev",
        "status": "running",
        "started": "2026-01-01T00:00:00Z",
    }
    store.put("run", run["id"], run)
    identity = artifacts.capture({"path": str(source), "format": "csv"}, run, "export", [tmp_path])
    with artifacts.open(identity, worktree["id"], "dev", "export", "run_test") as (stream, record):
        assert stream.read() == b"value\n42\n"
        assert record["size"] == len(b"value\n42\n")


@pytest.mark.parametrize("storage_kind", ["download", "partition"])
def test_parquet_storage_is_independent_of_format(services, tmp_path, storage_kind):
    store, projects, _, engine = services
    tree = projects.create("Parquet storage")
    run = {
        "id": "run_parquet",
        "project": tree["project"],
        "worktree": tree["id"],
        "environment": "dev",
        "status": "success",
        "started": "2026-01-01T00:00:00Z",
    }
    store.put("run", run["id"], run)
    source = tmp_path / "report.parquet"
    source.write_bytes(b"PAR1")
    artifacts = engine.exports.artifacts
    identity = artifacts.capture(
        {"path": str(source), "format": "parquet"}, run, "export", [tmp_path], storage_kind=storage_kind
    )
    record = store.get("artifact", identity)
    path = artifacts.path(record)
    assert record["storage_kind"] == storage_kind
    directory = (
        store.paths.partition_artifacts(tree["id"], "dev")
        if storage_kind == "partition"
        else artifacts.directory
    )
    assert path.parent == directory and path.exists()
    with artifacts.open(identity, tree["id"], "dev", "export", run["id"]) as (stream, _):
        assert stream.read() == b"PAR1"
    artifacts.remove(identity)
    assert not path.exists() and store.get("artifact", identity) is None
