"""Generated service units keep the intended interpreter and quote paths safely."""

import argparse
import sys

import pytest

from duckpad import cli
from duckpad.service_unit import render_unit
from duckpad.util import Problem


def options(home):
    return argparse.Namespace(home=home, host="127.0.0.1", port=8765, log_level="info", trusted_local=True)


def test_service_unit_keeps_venv_interpreter_and_literal_path_characters(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    interpreter = tmp_path / "virtual environment" / "python"
    interpreter.parent.mkdir()
    interpreter.symlink_to(sys.executable)
    monkeypatch.setattr(sys, "executable", str(interpreter))
    home = tmp_path / 'my %n $HOME "instance"'
    unit = render_unit(options(home))
    assert f'ExecStart="{interpreter}" "-m" "duckpad" "start"' in unit
    assert r"my %%n $$HOME \"instance\"" in unit
    assert '"--trusted-local"' in unit and '"--no-browser"' in unit
    assert "UMask=0077" in unit
    assert not home.exists()


def test_service_unit_rejects_control_characters(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    with pytest.raises(Problem, match="control characters"):
        render_unit(options(tmp_path / "invalid\npath"))


def test_service_unit_reports_unsupported_platform_without_installing_anything(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "platform", "win32")
    with pytest.raises(Problem, match="systemd user service on Linux"):
        render_unit(options(tmp_path / "instance"))
    assert list(tmp_path.iterdir()) == []


def test_main_commands_lead_the_help_and_info_replaces_duplicate_commands(monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["duckpad", "--help"])
    with pytest.raises(SystemExit) as exit:
        cli.main()
    assert exit.value.code == 0
    text = capsys.readouterr().out
    assert "{start,run,info,backup,restore,reset-password,service-unit}" in text
    assert "{version," not in text and "paths," not in text


def test_missing_git_is_an_operational_error(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli.shutil, "which", lambda name: None)
    monkeypatch.setattr(sys, "argv", ["duckpad", "start", "--home", str(tmp_path / "instance")])
    with pytest.raises(SystemExit) as exit:
        cli.main()
    assert exit.value.code == 1
    text = capsys.readouterr().err
    assert "Git is required" in text and "usage:" not in text
    assert not (tmp_path / "instance").exists()
