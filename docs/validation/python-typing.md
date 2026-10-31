# Python typing validation

GENERAL-411 uses ty 0.0.95 with Ruff signature checks. The comparison below uses
mypy 2.4.1 (compiled), Ruff 0.17.2, Python 3.12.12, and the same 67 backend files
on Linux x86_64 with eight available CPUs. Both configurations pass on this tree.
The old configuration comes from commit `89750158fea5938ae149dade35cbe12a597781ca`.

## Performance

Measured on 2026-10-30. Each result is the median of five fresh process executions,
after one warm-up, interleaving the three cases. Each execution includes the type
checker and then Ruff on `src/duckpad`; the ty case includes the additional
signature rules. Downloads, installation, tests, and builds are outside the timer.
No other checks or builds were launched during measurement. Operating system file
caches were not flushed: "uncached" refers to mypy's analysis cache only.

| Configuration | Total time | Type checker time | Peak RSS |
| --- | ---: | ---: | ---: |
| mypy without analysis cache + Ruff | 16.589 s | 16.516 s | 383.4 MiB |
| mypy with valid cache, no edits + Ruff | 0.457 s | 0.417 s | 69.2 MiB |
| ty + Ruff | 0.543 s | 0.515 s | 224.7 MiB |

ty is 30.5 times faster than the uncached mypy workflow and uses about 41% less
peak memory in that comparison. A repeated no-change check favors cached mypy:
ty takes about 19% longer and uses more memory. These measurements support the CI
use case; they do not establish an advantage for every local editing workflow.
Watch mode and language server latency were not measured.

Times use `time.perf_counter()` around child processes. RSS uses Linux
`os.wait4(...).ru_maxrss`; for each sequential checker/Ruff pair, the larger peak
is recorded. Raw samples, tool versions, and the source fingerprint are in
[python-typing.json](python-typing.json).

To reproduce from the repository root after setup:

```sh
mkdir -p .multica/typing/baseline
git show 89750158fea5938ae149dade35cbe12a597781ca:pyproject.toml > .multica/typing/baseline/pyproject.toml
uv pip install mypy==2.4.1
# Uncached mypy case:
.venv/bin/mypy --config-file .multica/typing/baseline/pyproject.toml --no-incremental --cache-dir /dev/null
# Warm mypy case; run once before measuring:
.venv/bin/mypy --config-file .multica/typing/baseline/pyproject.toml --cache-dir .multica/typing/mypy-cache
# Append this lint command to both mypy cases:
.venv/bin/ruff check --config .multica/typing/baseline/pyproject.toml --no-cache src/duckpad
# ty case, with the new signature policy:
.venv/bin/ty check
.venv/bin/ruff check --no-cache src/duckpad
# Remove the temporary comparison dependency afterward:
uv sync --locked
```

## Developer experience and coverage

- ty's default diagnostics show the incompatible value and the declaration that
  constrains it. The preview-limit probe, for example, identifies the string
  argument and points to `Engine.preview`'s `int` parameter declaration.
- Ruff requires parameter and return annotations on API handlers and the strict
  engine, execution, Git command, and locking modules. It was already part of CI;
  no additional lint tool is introduced. Explicit `Any` remains allowed at dynamic
  JSON document boundaries.
- All backend files are discovered automatically. The former 16 whole-module
  mypy suppressions become 16 specific rule/file pairs across 10 legacy files.
  An unsuppressed audit reports 26 diagnostics covered by those pairs. The CI gate
  rejects new pairs, wildcard or whole-file exclusions, and broader signature
  exemptions. No Authlib import exception is needed.
- Deliberate errors verify binary/text Git results, preview argument types, project
  lock identifiers, cancellation tokens, and missing function annotations.
- Runtime interfaces are explicit where ty needs them: native cursor forwarding,
  generator context managers, and Git overload keywords. The variable APIs added
  on `main` are retained and annotated when resolving the PR's merge conflicts.

The rules are not identical to mypy's strict mode. In particular, ty has no direct
equivalent to `no-untyped-call`, and some implicit re-export checks differ. The
strict configuration follows Astral's guidance with targeted rules and Ruff rather
than claiming exact parity. See the [migration guide and rule mapping](https://docs.astral.sh/ty/coming-from-mypy-or-pyright/).
The ty version is pinned so rule changes arrive through reviewed updates.
