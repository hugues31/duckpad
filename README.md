# Duckpad

### See the flow. Trust the result.

An open-source SQL workspace powered by **DuckDB 2.0**. Turn scattered data into
visual pipelines, explore the results and trace a number all the way back to its
source.

[**Get started →**](docs/QUICKSTART.md) · [Take the tour](docs/EXAMPLE.md) · [Contribute](CONTRIBUTING.md)

![Duckpad: the Northstar pipeline and its revenue results](docs/images/workspace.png)

- **Compose visually.** Connect sources, joins and reusable components. Use guided
  forms or write SQL in the integrated editor.
- **Understand the result.** Click a valid cell to explore its contributing source
  values, with [explicit lineage coverage](docs/LINEAGE.md).
- **Iterate with confidence.** Save to Git, branch independently, compare changes
  visually and review a merge before applying it.
- **Keep control.** Run on your infrastructure, configure connections per
  environment and manage project access for your team.

## Try it

With Python 3.11+ and Git installed:

```sh
pip install duckpad
duckpad start
```

SQL execution requires Linux with Landlock ABI 2+ (Linux 5.19+ with Landlock
enabled). Open the printed local address and sign in with the initial admin
password from the terminal. Choose **Open example project**, then **Run pipeline**.

The package includes the interface; Node.js is only needed for development.
See the [quickstart](docs/QUICKSTART.md) for the complete first-run walkthrough.

## Go further

[Installation & accounts](docs/INSTALLATION.md) · [Pipelines & SQL](docs/AUTHORING.md) ·
[Version control](docs/GIT.md) · [Connections](docs/CONNECTORS.md) ·
[Architecture](docs/ARCHITECTURE.md) · [Validation](docs/VALIDATION.md) ·
[Releases](docs/RELEASING.md) · [Security](SECURITY.md)

The [website and documentation guide](docs/WEBSITE.md) explains local preview,
Playwright demo recording and GitHub Pages publishing. Developer checks live in
[CONTRIBUTING.md](CONTRIBUTING.md); the private issue workflow is described in
[docs/MULTICA.md](docs/MULTICA.md).

**MIT licensed.** Built for the open-source community.
