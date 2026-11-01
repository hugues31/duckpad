# Duckpad

[![Tests](https://github.com/hugues31/duckpad/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/hugues31/duckpad/actions/workflows/ci.yml)
[![PyPI version](https://img.shields.io/pypi/v/duckpad.svg)](https://pypi.org/project/duckpad/)
[![Python versions](https://img.shields.io/pypi/pyversions/duckpad.svg)](https://pypi.org/project/duckpad/)
[![License: MIT](https://img.shields.io/github/license/hugues31/duckpad.svg)](LICENSE)

### See the flow. Trust the result.

An open-source SQL workspace powered by **DuckDB 2.0**. Turn scattered data into
visual pipelines, explore the results and trace a number all the way back to its
source.

[![Visit the website](https://img.shields.io/badge/Visit_the_website-1858de?style=for-the-badge)](https://hugues31.github.io/duckpad/)

[![Watch Duckpad in one minute: build visual pipelines and version your work](docs/images/duckpad-overview.jpg)](https://hugues31.github.io/duckpad/#demo)

- **Compose visually.** Connect sources, joins and reusable components. Use guided
  forms to prepare columns and values, or write your own SQL nodes.
- **Explore and check your data.** Sample and filter results, save views, compute
  column statistics, and keep data tests and execution messages next to your SQL.
- **Explain a number.** Follow a result cell back to its contributing source
  values, with [explicit lineage coverage](docs/LINEAGE.md).
- **Iterate with confidence.** Save to Git, branch independently, compare changes
  visually and review a merge before applying it.
- **Run repeatable work.** Share typed variables across nodes and environments,
  then launch Jobs against reviewed versions from the interface, CLI or a scheduler.
- **Ask for help in context.** Use the AI assistant to explain a flow, inspect
  its edits and confirm executions with your existing project permissions.
- **Keep control.** Run on your infrastructure, configure connections per
  environment, manage team access and import extensions for offline use.

## Try it

With Python 3.11+ and Git installed:

```sh
pip install duckpad
duckpad start
```

Open the printed local address and sign in with the initial admin
password from the terminal. Follow **[Duckpad in 15 minutes](docs/QUICKSTART.md)**
to build your first pipeline from scratch, write SQL and explain a result.

Prefer a ready-made project? Choose **New project → Start from an example**,
enter a name, then **Create → Run pipeline** to explore Northstar.
See [installation](docs/INSTALLATION.md) for platform requirements and setup options.

## Go further

| Build | Understand | Share and run |
| --- | --- | --- |
| [SQL syntax](docs/SQL.md) | [Results and samples](docs/RESULTS.md) | [Version control](docs/GIT.md) |
| [Data preparation](docs/DATA_PREPARATION.md) | [Data tests](docs/TESTS.md) | [Jobs](docs/JOBS.md) |
| [Reusable components](docs/COMPONENTS.md) | [Messages and logs](docs/MESSAGES.md) | [CLI and automation](docs/AUTOMATION.md) |
| [Variables](docs/VARIABLES.md) | [Lineage](docs/LINEAGE.md) | [Connections](docs/CONNECTORS.md) |
| [Project files](docs/AUTHORING.md) | [AI assistant](docs/ASSISTANT.md) | [Environments](docs/ENVIRONMENTS.md) |

[Installation & accounts](docs/INSTALLATION.md) · [Single sign-on](docs/SSO.md) ·
[Offline extensions](docs/OFFLINE_EXTENSIONS.md) · [Project documentation](docs/DOCUMENTATION.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Validation](docs/VALIDATION.md) ·
[Releases](docs/RELEASING.md) · [Security](SECURITY.md)

Want to contribute? Start with [CONTRIBUTING.md](CONTRIBUTING.md).

**MIT licensed.** Built for the open-source community.
