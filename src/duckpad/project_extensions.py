"""Portable project requirements and strictly local extension activation.

Only instance administrators install binaries. Project editors select an origin and
enable a capability; neither resolving nor loading a requirement installs anything.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

import duckdb

from .extensions import SOURCES, runtime
from .util import Problem, dumps, qi

FILE = "extensions.json"
NAME = re.compile(r"[a-z][a-z0-9_]{0,63}")
# Execution sessions load only built-in, project and connector extensions: DuckDB never
# loads or downloads one on demand, so a project behaves the same in every execution mode.
EXPLICIT_LOADING = {"autoload_known_extensions": False, "autoinstall_known_extensions": False}
# DuckDB's error for a function, copy format or type that a known, unloaded extension provides,
# followed by INSTALL/LOAD advice that does not apply to Duckpad sessions.
MISSING = re.compile(r"(is not in the catalog, but it exists in the (\w+) extension\.).*", re.DOTALL)


def read(text):
    if text is None:
        return None
    try:
        return json.loads(text)
    except ValueError:
        # Preserve invalid text through unrelated UI edits, for correction in Code.
        return text


def write(value):
    return value if isinstance(value, str) else dumps(value)


def declarations(value):
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise Problem("extensions.json must contain an object keyed by extension name", 422)
    for name, item in value.items():
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise Problem("Extension names must contain lowercase letters, digits and underscores", 422)
        if (
            not isinstance(item, dict)
            or set(item) != {"source", "enabled"}
            or not isinstance(item.get("source"), str)
            or item.get("source") not in SOURCES
            or type(item.get("enabled")) is not bool
        ):
            raise Problem(
                f"Extension {name} needs a core, community or unsigned source and enabled boolean", 422
            )
    return value


def enabled(value):
    return [
        {"name": name, "source": item["source"]}
        for name, item in sorted(declarations(value).items())
        if item["enabled"]
    ]


def problems(bundle):
    try:
        declarations(bundle.get("extensions"))
        return []
    except Problem as error:
        return [{"file": FILE, "message": str(error)}]


def explain_missing(message):
    """Name the project extension to enable when a node uses a capability of an unloaded extension."""
    return MISSING.sub(
        lambda match: (
            f"{match[1]}\nEnable the {match[2]} extension in the project's Extensions tab; "
            "an instance administrator may need to import it first."
        ),
        message,
        count=1,
    )


def installed(db):
    result = db.execute(
        "SELECT extension_name, install_mode, installed_from FROM duckdb_extensions() WHERE installed"
    )
    return result.fetchall()


def resolve(requirement, imports, available, allow_unsigned, directory):
    """Return a local LOAD statement or actionable unavailability; never contact a catalog."""
    name, source = requirement["name"], requirement["source"]
    declarations({name: {"source": source, "enabled": True}})
    if source == "unsigned" and not allow_unsigned:
        return {
            "status": "policy",
            "message": "Unsigned extensions are disabled. Ask an instance administrator to review the trust policy.",
        }
    entry = imports.get(name)
    if entry and entry["source"] == source:
        version, platform = runtime()
        if (entry["version"], entry["platform"]) != (version, platform):
            return {
                "status": "incompatible",
                "message": f"Import {name} for this server's DuckDB {version} / {platform} in Instance settings → Extensions.",
            }
        binary = (
            Path(directory)
            / version
            / platform
            / "repositories"
            / entry["repository"]
            / (name + ".duckdb_extension")
        )
        if binary.is_file():
            return {"status": "ready", "sql": f"LOAD {qi(name)} FROM {qi(entry['repository'])}"}
    for installed_name, mode, origin in available:
        if installed_name != name:
            continue
        if source == "core" and mode == "STATICALLY_LINKED":
            return {"status": "ready", "sql": f"LOAD {qi(name)}"}
        if source != "unsigned" and origin == source:
            return {"status": "ready", "sql": f"LOAD {qi(name)} FROM {qi(source)}"}
    return {
        "status": "missing",
        "message": f"Import {name} from {source} in Instance settings → Extensions. An instance administrator must install a compatible binary first.",
    }


def load(db, requirements, imports, allow_unsigned):
    if not requirements:
        return
    available = installed(db)
    directory = db.execute("SELECT current_setting('extension_directory')").fetchone()[0]
    for requirement in requirements:
        result = resolve(requirement, imports, available, allow_unsigned, directory)
        if result["status"] != "ready":
            raise Problem(result["message"], 422)
        try:
            db.execute(result["sql"])
        except duckdb.Error as error:
            raise Problem(
                f"Cannot load project extension {requirement['name']} ({requirement['source']}): {error}. "
                "Ask an instance administrator to check its binary, dependencies and signature in Instance settings → Extensions.",
                422,
            ) from None


def check(config, requirements, imports):
    """Probe native code in a disposable process, containing a bad binary's crash."""
    try:
        result = subprocess.run(
            [sys.executable, "-m", "duckpad.project_extensions"],
            input=json.dumps({"config": config, "requirements": requirements, "imports": imports}),
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise Problem(
            "Extension loading timed out. Ask an instance administrator to check the binary and its dependencies.",
            422,
        ) from None
    if result.returncode:
        detail = (
            result.stderr.strip()
            if result.returncode == 1
            else f"The extension process exited with code {result.returncode}. Check the server CPU and native dependencies."
        )
        raise Problem(
            "Extension loading failed: " + detail.replace(config["extension_directory"], "<extensions>"), 422
        )


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    try:
        with duckdb.connect(config={**payload["config"], "threads": 1, **EXPLICIT_LOADING}) as database:
            load(
                database,
                payload["requirements"],
                payload["imports"],
                payload["config"]["allow_unsigned_extensions"],
            )
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
