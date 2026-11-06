"""Project-relative source files and bounded previews in a disposable process."""

import json
import re
import subprocess
import sys
from pathlib import Path

import duckdb

from . import project_extensions
from .util import Problem, clean, inside

FORMATS = {
    ".csv": "csv",
    ".tsv": "csv",
    ".parquet": "parquet",
    ".xlsx": "xlsx",
    ".json": "json",
    ".jsonl": "json",
    ".ndjson": "json",
}


def file_name(path: str) -> str:
    return re.sub(r"^[0-9a-f]{16}_", "", Path(path).name)


def list_files(folder: Path) -> list[dict]:
    if not folder.exists():
        return []
    return [
        {"path": path.relative_to(folder).as_posix(), "name": file_name(path.name)}
        for path in sorted(folder.rglob("*"))
        if path.is_file()
        and path.resolve().is_relative_to(folder.resolve())
        and not any(part.startswith(".") for part in path.relative_to(folder).parts)
        and path.suffix.lower() in FORMATS
    ]


def sample(db, sql, values=None):
    """Read a query whose SQL already limits the result to twenty rows."""
    result = db.execute(sql, values or [])
    columns = [{"name": column[0], "type": str(column[1])} for column in result.description]
    return {"columns": columns, "rows": clean(result.fetchall())}


def preview(folder, file, options, config, requirements, imports):
    if not file or Path(file).is_absolute() or "\\" in file:
        raise Problem("Choose a project file", 422)
    path = inside(folder, file)
    if not path.is_file():
        raise Problem("Project file not found", 404)
    if path.suffix.lower() not in FORMATS:
        raise Problem("Choose a CSV, Parquet, XLSX or JSON file", 422)
    payload = {
        "path": str(path),
        "options": options,
        "config": config,
        "requirements": requirements,
        "imports": imports,
    }
    try:
        result = subprocess.run(
            [sys.executable, "-m", "duckpad.source_files"],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise Problem("Source preview timed out. Try a smaller file.", 422) from None
    if result.returncode:
        # DuckDB errors echo their SQL and file names. Never expose server paths.
        detail = result.stderr.strip() if result.returncode == 1 else "The file reader stopped unexpectedly."
        for private, public in (
            (str(path), file_name(file)),
            (str(folder), "<project files>"),
            (config["extension_directory"], "<extensions>"),
        ):
            detail = detail.replace(private, public)
        raise Problem(project_extensions.explain_missing(detail), 422)
    return json.loads(result.stdout)


def read_sample(db, path, options):
    kind = FORMATS[Path(path).suffix.lower()]
    settings = {}
    if kind == "csv":
        arguments, values = [], [path]
        for key in ("delimiter", "header"):
            if options.get(key) is not None:
                arguments.append(f"{key}=?")
                values.append(options[key])
        suffix = ", " + ", ".join(arguments) if arguments else ""
        sniff = db.execute(
            f"SELECT Delimiter, HasHeader, Columns FROM sniff_csv(?{suffix})", values
        ).fetchone()
        settings = {"delimiter": sniff[0], "header": sniff[1]}
        types = options.get("types") or {}
        if not isinstance(types, dict) or not all(isinstance(v, str) for v in types.values()):
            raise Problem("Column types must map column names to types")
        result = sample(
            db,
            "SELECT * FROM read_csv(?, delim=?, header=?" + (", types=?" if types else "") + ") LIMIT 20",
            [path, sniff[0], sniff[1]] + ([types] if types else []),
        )
        result["detected_columns"] = [{"name": c["name"], "type": c["type"]} for c in sniff[2]]
    elif kind == "xlsx":
        result = sample(
            db,
            "SELECT * FROM read_xlsx(?, sheet=?, header=?, all_varchar=?) LIMIT 20",
            [path, options.get("sheet", ""), options.get("header", True), options.get("all_varchar", False)],
        )
    else:
        function = "read_parquet" if kind == "parquet" else "read_json_auto"
        result = sample(db, f"SELECT * FROM {function}(?) LIMIT 20", [path])
    return {**result, "settings": settings}


def main():
    payload = json.load(sys.stdin)
    with duckdb.connect(
        config={
            **payload["config"],
            "threads": 1,
            "memory_limit": "256MB",
            **project_extensions.EXPLICIT_LOADING,
        }
    ) as db:
        project_extensions.load(
            db,
            payload["requirements"],
            payload["imports"],
            payload["config"].get("allow_unsigned_extensions", False),
        )
        print(json.dumps(read_sample(db, payload["path"], payload["options"])))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
