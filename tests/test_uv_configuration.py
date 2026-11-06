"""Operator uv configuration discovery, source validation and real resolver policy."""

import functools
import http.server
import io
import json
import os
import subprocess
import sys
import tarfile
import threading
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from test_python_environment import lock

from duckpad import python_environment as environment
from duckpad.util import Problem


@pytest.fixture
def config_files(tmp_path, monkeypatch):
    for name in os.environ:
        if name.startswith("UV_") or name.upper().endswith("_PROXY"):
            monkeypatch.delenv(name)
    home = tmp_path / "home"
    user = home / ("AppData/Roaming" if sys.platform == "win32" else ".config")
    system = tmp_path / "system"
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("APPDATA", str(user))
    monkeypatch.setenv("SYSTEMDRIVE", str(system))
    monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
    monkeypatch.setenv("XDG_CONFIG_DIRS", str(system))
    monkeypatch.setenv("UV_CACHE_DIR", str(tmp_path / "cache"))
    if sys.platform == "win32":
        system /= "ProgramData"
    files = {"user": user / "uv/uv.toml", "system": system / "uv/uv.toml"}
    for path in files.values():
        path.parent.mkdir(parents=True)
        path.write_text("")
    return files


def test_config_sources_merge_and_replace_pypi(config_files, tmp_path):
    config_files["system"].write_text(
        'index-url = "https://system.example/simple"\n'
        'extra-index-url = ["https://extra.example/simple/"]\n'
        f"find-links = [{json.dumps(str(tmp_path))}]\n"
        '[[index]]\nname = "internal"\nurl = "https://internal.example/simple/"\n'
    )
    config_files["user"].write_text('index-url = "https://user.example/simple/"\n')
    assert environment.operator_sources() == {
        "https://user.example/simple",
        "https://extra.example/simple",
        "https://internal.example/simple",
        str(tmp_path),
    }
    for registry in environment.operator_sources() - {str(tmp_path)}:
        environment.check_lock_sources(lock(registry, f"url = '{registry}/package.whl'"))
    environment.check_lock_sources(lock(str(tmp_path), "path = 'package.whl'"))
    for registry in (environment.PYPI, "https://system.example/simple", "https://undeclared.example/simple"):
        with pytest.raises(Problem, match="source the server does not use"):
            environment.check_lock_sources(lock(registry))


@pytest.mark.parametrize("location", ["user", "system"])
@pytest.mark.parametrize("default", [False, True])
def test_named_config_indexes_and_pypi(config_files, location, default):
    config_files[location].write_text(
        '[[index]]\nurl = "https://mirror.example/simple"\n' + f"default = {str(default).lower()}\n"
    )
    assert (environment.PYPI in environment.operator_sources()) is not default
    environment.check_lock_sources(lock("https://mirror.example/simple"))


def test_environment_indexes_combine_with_files(config_files, monkeypatch):
    config_files["system"].write_text('extra-index-url = ["https://system.example/simple"]\n')
    monkeypatch.setenv("UV_DEFAULT_INDEX", "internal=https://environment.example/simple")
    assert environment.operator_sources() == {
        "https://system.example/simple",
        "https://environment.example/simple",
    }


@pytest.mark.skipif(sys.platform == "win32", reason="XDG configuration discovery is Unix-specific")
def test_xdg_discovery_uses_first_system_file(config_files, tmp_path, monkeypatch):
    user = tmp_path / "custom-user" / "uv" / "uv.toml"
    user.parent.mkdir(parents=True)
    user.write_text('extra-index-url = ["https://user.example/simple"]\n')
    config_files["user"].write_text('index-url = "https://ignored.example/simple"\n')
    config_files["system"].write_text('index-url = "https://system.example/simple"\n')
    second = tmp_path / "second" / "uv" / "uv.toml"
    second.parent.mkdir(parents=True)
    second.write_text('index-url = "https://ignored.example/simple"\n')
    monkeypatch.setenv("XDG_CONFIG_HOME", str(user.parent.parent))
    monkeypatch.setenv(
        "XDG_CONFIG_DIRS",
        f"{tmp_path / 'missing'}::{config_files['system'].parent.parent}:{second.parent.parent}",
    )
    assert environment.operator_sources() == {"https://system.example/simple", "https://user.example/simple"}


@pytest.mark.skipif(sys.platform == "win32", reason="XDG configuration discovery is Unix-specific")
def test_system_fallback_and_relative_user_directory(config_files, monkeypatch):
    monkeypatch.setenv("XDG_CONFIG_HOME", "relative-is-ignored")
    monkeypatch.setenv("XDG_CONFIG_DIRS", "")
    monkeypatch.setattr(Path, "is_file", lambda path: path == Path("/etc/uv/uv.toml"))
    assert environment.operator_config_paths() == [config_files["user"], Path("/etc/uv/uv.toml")]
    monkeypatch.setattr(
        Path, "is_file", lambda path: path in (Path("/etc/xdg/uv/uv.toml"), Path("/etc/uv/uv.toml"))
    )
    assert environment.operator_config_paths() == [config_files["user"], Path("/etc/xdg/uv/uv.toml")]


def test_invalid_operator_toml_fails_without_disclosing_contents(config_files):
    config_files["user"].write_text('index-url = "https://secret:password@mirror.example')
    with pytest.raises(Problem, match=r"Cannot read operator uv\.toml") as error:
        environment.operator_sources()
    assert "password" not in str(error.value)


@pytest.fixture
def wheel_index(tmp_path):
    root = tmp_path / "index"
    package = root / "simple" / "operator_probe"
    package.mkdir(parents=True)
    wheel = package / "operator_probe-1.0-py3-none-any.whl"
    with zipfile.ZipFile(wheel, "w") as archive:
        archive.writestr("operator_probe.py", "VALUE = 42\n")
        archive.writestr(
            "operator_probe-1.0.dist-info/METADATA",
            "Metadata-Version: 2.1\nName: operator-probe\nVersion: 1.0\n",
        )
        archive.writestr(
            "operator_probe-1.0.dist-info/WHEEL",
            "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        )
        archive.writestr("operator_probe-1.0.dist-info/RECORD", "")
    (package / "index.html").write_text(f'<a href="{wheel.name}">{wheel.name}</a>')
    package.rename(package.with_name("operator-probe"))

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            # Also act as a local HTTP proxy for the synthetic index hostname.
            self.path = urlsplit(self.path).path
            super().do_GET()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Handler, directory=root))
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/simple"
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def project(tmp_path, dependency="operator-probe==1.0"):
    directory = tmp_path / "python" / "environment"
    directory.mkdir(parents=True)
    (directory / "pyproject.toml").write_text(
        '[project]\nname = "configuration-probe"\nversion = "1.0"\n'
        f"dependencies = [{json.dumps(dependency)}]\n"
        f'requires-python = ">={sys.version_info.major}.{sys.version_info.minor}"\n'
        "[tool.uv]\npackage = false\n"
    )
    # Discovery must stop at the generated [tool.uv], even with a parent uv.toml.
    (directory.parent / "uv.toml").write_text('required-version = "==0.0.0"\n')
    return directory


@pytest.mark.parametrize("location", ["user", "system"])
def test_real_uv_locks_and_installs_from_operator_index(config_files, wheel_index, tmp_path, location):
    config_files[location].write_text(f'index-url = "{wheel_index}"\nno-build = false\n')
    directory = project(tmp_path)
    environment.command(["lock", "--python", sys.executable], directory)
    locked = (directory / "uv.lock").read_text()
    assert wheel_index in locked
    environment.check_lock_sources(locked)
    environment.command(["sync", "--locked", "--python", sys.executable], directory)
    interpreter = directory / ".venv" / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")
    subprocess.run(
        [str(interpreter), "-c", "import operator_probe; assert operator_probe.VALUE == 42"], check=True
    )


def test_real_uv_merges_user_index_with_system_proxy(config_files, wheel_index, tmp_path):
    proxy = wheel_index.removesuffix("/simple")
    config_files["system"].write_text(
        f'http-proxy = "{proxy}"\nhttps-proxy = "{proxy}"\nno-proxy = ["localhost"]\nsystem-certs = true\n'
    )
    config_files["user"].write_text(
        '[[index]]\nname = "internal"\nurl = "http://index.example.invalid/simple"\ndefault = true\n'
    )
    directory = project(tmp_path)
    environment.command(["lock", "--python", sys.executable], directory)
    environment.check_lock_sources((directory / "uv.lock").read_text())
    environment.command(["sync", "--locked", "--python", sys.executable], directory)


@pytest.mark.parametrize("location", ["user", "system"])
def test_real_uv_applies_offline_and_cache_settings(config_files, tmp_path, monkeypatch, location):
    monkeypatch.delenv("UV_CACHE_DIR")
    cache = tmp_path / "configured-cache"
    config_files[location].write_text(f"offline = true\ncache-dir = {json.dumps(str(cache))}\n")
    with pytest.raises(Problem, match=r"(?s)(offline|network.*disabled)"):
        environment.command(["lock", "--python", sys.executable], project(tmp_path))
    assert cache.is_dir()


def test_real_uv_does_not_enable_builds_from_config(config_files, tmp_path):
    wheels = tmp_path / "wheels"
    wheels.mkdir()
    marker = tmp_path / "backend-ran"
    with tarfile.open(wheels / "operator_probe-1.0.tar.gz", "w:gz") as archive:
        for name, text in {
            "pyproject.toml": '[build-system]\nrequires = []\nbuild-backend = "backend"\nbackend-path = ["."]\n',
            "backend.py": f'from pathlib import Path\nPath({str(marker)!r}).touch()\nraise RuntimeError("backend ran")\n',
        }.items():
            data = text.encode()
            member = tarfile.TarInfo("operator_probe-1.0/" + name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    config_files["system"].write_text(
        f"no-build = false\nno-index = true\nfind-links = [{json.dumps(str(wheels))}]\n"
    )
    with pytest.raises(Problem, match=r"(?s)(building.*disabled|source distributions.*disabled)"):
        environment.command(["lock", "--python", sys.executable], project(tmp_path))
    assert not marker.exists()
