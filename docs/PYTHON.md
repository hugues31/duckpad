# Python nodes

An administrator enables **Python execution** in project settings. An editor can
then click the **Python** button at the bottom of the palette and edit the new
template; the editor saves as you type. Click or drag its new palette entry onto
the flow and connect its tabular ports to SQL nodes. Each ordinary insertion owns
an independent copy of the code; **Add linked** creates instances that share the
template. Results, parameters, messages and downloads use the same panels.
Operators run reviewed jobs; they cannot activate Python or edit its code.
Assistant run approvals list the Python nodes that will execute.

Use a `# @label My transform` comment to name the template's palette entry.

## Author a node

```python
import duckpad as dp
from duckdb import col

class Split(dp.Node):
    minimum: int = dp.param(default=100, ge=0)
    column: dp.Column = dp.param(default="amount", input="orders")

    class Outputs(dp.Outputs):
        accepted: dp.Relation
        rejected: dp.Relation

    def run(self, orders: dp.Relation) -> Outputs:
        self.message("info", "Splitting orders")
        return self.Outputs(
            accepted=orders.filter(col(self.column) >= self.minimum),
            rejected=orders.filter(col(self.column) < self.minimum),
        )
```

Declare exactly one direct `dp.Node` subclass, imported as `dp`. Annotated
attributes are instance parameters; `typing.ClassVar` constants are excluded.
Use `str`, `int`, `float`, `bool`, `dp.Date`, `typing.Literal["one", "two"]`,
`dp.Column`, `dp.Connection`, `dp.File`, `dp.Destination`, `dp.SchemaName` or
`dp.TableName`. `dp.param` accepts literal defaults, labels, descriptions,
numeric `ge/gt/le/lt` constraints, choices and input/connection/schema bindings.
Defaults are overridden by each instance's saved values. Integer values reject
fractions and booleans; numbers must be finite. Column selections are validated
against the actual input schema before any project code executes.

The editor reads the Python AST without importing the module. Defaults and
metadata must be literals. Dynamic inheritance, decorators on the node or `run`,
custom constructors and computed contracts are unsupported. An invalid edit or
removed connected port retains the last valid signature, edges and values and
blocks execution until corrected. It never silently disconnects the graph.

Each named argument to `run` must be a `dp.Relation`. A single `dp.Relation`
return annotation creates `result`; a nested `dp.Outputs` class declares fixed
named outputs; `-> None` declares no output. Nodes without inputs are sources,
nodes with inputs and outputs are transformations, and nodes without outputs are
exports. File ports are not supported. Use managed artifacts for downloads.

SQL and Python execute in the **same worker and DuckDB connection**. Inputs are
relations over materialized SQL results; create new relations using `self.db` or
the input relations. A relation from `duckdb.sql()` or a separate connection is
rejected: it belongs to another database. Outside Duckpad the SDK is ordinary
Python: `node = Split(minimum=10)`, followed by `node.run(orders=...)`, works with
the installed Duckpad package. `node.db` creates a connection lazily for a source.
Managed artifacts and authorized connections need a Duckpad execution context.

## Dependencies and helper modules

`nodes/<id>.py`, reusable `templates/<id>.py` and
`components/<component>/<node>.py` are versioned with the graph. Add shared
helpers under `modules/`, for example `modules/business.py`, then
`from business import ...`. The **Code** panel can create helper modules.
ZIP export/import includes code, helpers, `pyproject.toml` and `uv.lock`, never
the local environment. Component imports copy helpers and report conflicting
helpers or missing dependency declarations instead of installing them silently.

Add business dependencies to `project.dependencies` in `pyproject.toml`.
Saving a change to `pyproject.toml` or `uv.lock` in an enabled Python project
resolves and commits `uv.lock`; the save remains pending while uv prepares the
lock, with resolver errors shown in the editor. Other saves keep the current lock.
The first execution creates a cached project environment. Environments are
immutable and separated by project, manifest, lock and runtime fingerprint.
Changing a helper, code or dependencies invalidates the affected results.
Run again after a dependency change; existing contexts are recreated.

Keep the generated `duckdb==...` pin, `.duckpad-runtime/...` source and
`tool.duckpad.sdk-contract`. The runtime wheel is supplied from the server's
installed DuckDB binary, including an operator's portable CPU build. It is not
downloaded from PyPI. The SDK is installed in the prepared environment and has no API-server dependencies. That environment’s interpreter can also import `duckpad` directly for local node calls. Package `.pth` hooks run only after the worker applies confinement. The
generated `pytz` dependency supports DuckDB timestamp conversion. Tags and jobs
use `uv --locked`: missing, conflicting, stale or incompatible locks fail without
editing the tag. Regenerate a conflicted lock on an editable branch and tag the
result. Moving a project to another Python ABI, OS or DuckDB runtime requires
updating these declarations and its lock on an editable branch first. Until then,
runs report the expected runtime source; edits that leave dependencies alone still save.

The server installation includes `uv`. Wheels are required by default; source builds
need a separate administrator opt-in and run dependency build code with the
server account's permissions. This opt-in requires trust in those dependencies.
An offline installation can provide `UV_OFFLINE`, `UV_CACHE_DIR`, `UV_FIND_LINKS`
or an operator index via `UV_INDEX` / `UV_DEFAULT_INDEX` / `UV_EXTRA_INDEX_URL`,
with `UV_INDEX_<NAME>_USERNAME` / `_PASSWORD` for an authenticated index and the
standard `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` variables. User and system
`uv.toml` files can also supply these settings (see below). Cache the locked wheels
in advance. Project manifests cannot override the operator index, cache, or build policy, including through optional dependencies or dependency groups. A `uv.lock` that takes packages from another index or file host is resolved again on an editable branch and refused for tags. Validated manifest/lock pairs are cached, so unchanged executions do not relock or contact the index. A missing offline dependency produces a preparation error. The
operator can supply `DUCKPAD_RUNTIME_WHEEL` matching the installed runtime.
The project’s Python settings show resolution, installation, readiness and the
last preparation error. Environments unused for seven days are removed during
later preparations; active workers hold a lease that prevents removal.

### Use an on-premises Artifactory index

Configure the environment of the **Duckpad server process** before starting it.
Python dependencies are resolved by the server's `uv`, so this is an instance-wide
operator setting, not a node parameter or a Duckpad connection. Installing `pytz`
in the server's own Python environment does not install it in project environments.

Use the Artifactory PyPI repository's **simple API** endpoint, for example:

```text
https://artifactory.example.com/artifactory/api/pypi/python-virtual/simple
```

The repository must serve `pytz` and all other project dependencies as compatible wheels. It can be
a virtual repository combining internal packages and a remote PyPI repository,
or a local repository populated in advance for an offline installation.

For a Bash terminal launch with authentication:

```bash
export UV_DEFAULT_INDEX='artifactory=https://artifactory.example.com/artifactory/api/pypi/python-virtual/simple'
export UV_INDEX_ARTIFACTORY_USERNAME='your-username'
read -r -s -p 'Artifactory password or access token: ' UV_INDEX_ARTIFACTORY_PASSWORD
export UV_INDEX_ARTIFACTORY_PASSWORD
duckpad start
```

The `artifactory=` prefix names the index; its name matches the
`UV_INDEX_ARTIFACTORY_USERNAME` and `UV_INDEX_ARTIFACTORY_PASSWORD` variables.
For JFrog JWT authentication, set the username to an empty string and supply the JWT
as the password. See [uv's Artifactory authentication guide](https://docs.astral.sh/uv/guides/integration/jfrog/).
Omit both credential variables for a repository that permits anonymous reads.

For Docker, Kubernetes or a system service, inject these same variables into the
running Duckpad container or service through its deployment configuration and
secret store, then restart it. Setting them only in a host terminal does not update
an existing service. Keep credentials out of node code, project files and index
URLs; the named index lets `uv.lock` record the repository without credentials.

`UV_DEFAULT_INDEX` **replaces PyPI**. Setting only `UV_INDEX` or
`UV_EXTRA_INDEX_URL` adds an index while retaining PyPI as a fallback. Remove
unwanted additional indexes when the server must use Artifactory exclusively.
See [uv's index selection rules](https://docs.astral.sh/uv/concepts/indexes/).
You can also configure the index in the service account's user or system
`uv.toml`, keeping credentials in the environment variables above:

```toml
[[index]]
name = "artifactory"
url = "https://artifactory.example.com/artifactory/api/pypi/python/simple"
default = true
```

`default = true` (or `index-url`) replaces PyPI; additional indexes retain it.
Duckpad accepts sources declared in these operator files when validating
`uv.lock`. `pip.conf` and `PIP_INDEX_URL` do not configure uv. Project index
overrides are still rejected: only `tool.uv.package` and the server's DuckDB
source may appear in the project manifest.

If Artifactory uses a private certificate authority, set `SSL_CERT_FILE` to a
PEM CA bundle readable by the Duckpad service account, and mount it into the
container when applicable. For example, set
`SSL_CERT_FILE=/path/to/company-ca-bundle.pem` in that service's environment.
The bundle replaces uv's default CA bundle, so include every CA needed by the
configured sources. Keep TLS verification enabled. Proxy settings, when needed,
also belong in the server environment (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`)
or its user/system `uv.toml` as shown below.
See [uv's custom CA configuration](https://docs.astral.sh/uv/concepts/authentication/certificates/#custom-certificates).

After restarting the server, run the Python node on an editable branch. Its
`uv.lock` still takes `pytz` from PyPI, so Duckpad resolves it again against
Artifactory and commits the new lock; no manual edit is needed. The project's
Python settings show the preparation status. Tags are immutable and refuse the
old PyPI lock: create a new tag from the updated branch before running jobs.

If preparation still fails:

- A request to `https://pypi.org/simple/pytz/` means the resolver is still using
  PyPI. Check the environment of the actual server process, its restart, and that
  a default index was configured with `UV_DEFAULT_INDEX`, `index-url` or
  `[[index]]` with `default = true`, rather than an additional index alone.
- A request to `files.pythonhosted.org` can come from upstream download links
  returned by a mirror. For an installation without public internet access,
  Artifactory must serve the wheel files itself as well as the simple index.
- HTTP 401/403 indicates a credential or repository permission problem. Check the
  index name and the account's read access to both metadata and wheel downloads.
- Certificate errors require the correct CA bundle; timeouts require checking
  DNS, firewall and proxy access from the server or container, not the browser.
- A missing package or compatible wheel must be made available in Artifactory.
  Setting `UV_OFFLINE=1` disables network access to Artifactory too; use it only
  when the required packages are already cached or available locally.

### User and system uv configuration

Duckpad reads uv configuration for the account running the **server**. On Linux
and macOS, user settings come from `$XDG_CONFIG_HOME/uv/uv.toml`, or
`~/.config/uv/uv.toml`. System settings come from the first `uv/uv.toml` found
in `$XDG_CONFIG_DIRS` (default `/etc/xdg`), falling back to `/etc/uv/uv.toml`.
On Windows, uv uses `%APPDATA%\uv\uv.toml` and
`%SYSTEMDRIVE%\ProgramData\uv\uv.toml`.

User settings override system settings; lists are combined with user entries
first. Environment variables override file settings. Proxy, certificates,
indexes and cache settings can all be configured in these files. For example:

```toml
https-proxy = "http://proxy.example.com:8080"
no-proxy = ["localhost", "127.0.0.1", ".example.com"]
system-certs = true
```

In Docker, the file must exist **inside the container**, for example by mounting
an operator-owned file read-only at `/etc/uv/uv.toml`. Install the company CA
certificates in the container's trust store when using `system-certs = true`.
The host account's configuration is not automatically available to the service.
See [uv configuration discovery](https://docs.astral.sh/uv/concepts/configuration-files/).

Duckpad's generated manifest stops discovery of project and parent-directory
configuration. `UV_CONFIG_FILE` and `UV_NO_CONFIG` are not forwarded. The server
still selects its own Python interpreter, disables Python downloads, copies
installed files and passes `--no-build` unless an administrator explicitly
allows source builds. Setting `no-build = false` in `uv.toml` cannot bypass that
policy. Isolated Linux workers cannot write the operator's configuration files;
keep those files outside writable project and connection directories.

## Checks, writes and artifacts

Execution creates a fresh instance, runs `run`, validates every output, evaluates
`self.check("name", failing_rows, severity="error")`, then calls optional
`write(self)`. Checks use a DuckDB relation of failing rows. Error messages and
failed error checks and invalid partition columns prevent `write` and publication; warning checks are visible
without failing the node. `self.message("info" | "warning" | "error", text)` and
bounded stdout/stderr appear in node results.

`self.artifact("report.zip")` returns a staged path. Successful completion
publishes an immutable download. Multiple files become one ZIP. Failures and
cancellation remove staged downloads and publish no partial output set. Arbitrary
HTTP, database or filesystem writes from user code cannot be rolled back; their
outcome may be partial or unknown after an error, timeout or crash. They are
never retried automatically. Prefer writes in `write` after checks.

`self.partition` contains the current execution key and attributes when running
a partition. Python uses the same partition scheduling and output filtering as
SQL. Schema-only / empty-manifest execution explicitly fails before running
project code; Duckpad cannot safely infer arbitrary Python output schemas.
Python calls within one context worker are serialized; different worktrees and
environments can execute concurrently. Duckpad cannot infer arbitrary Python
file paths or HTTP write targets, guarantee distinct partition destinations, or
serialize remote writes across contexts. Authors must derive distinct targets
from the partition key or provide coordination in the destination system.

## Data types, memory and lineage

Native relations retain DuckDB types, including decimals, huge integers, dates,
timezone timestamps, nulls and nested values. Tabular inputs and outputs never
travel as JSON or Python row collections between processes. The worker
materializes successful outputs once for the existing result and lineage model.
Scalar preview pages still use Duckpad's normal display encoding.

Return adapters accept Arrow tables or record-batch readers, pandas DataFrames,
and Polars DataFrames. Install the corresponding project libraries, including
`pyarrow` for Polars conversion. Converting to a DataFrame or Arrow table can
materialize all data and change types: prefer relations or Arrow readers for
large inputs. Use explicit schemas / pandas Arrow dtypes for nullable and exact
types. Unsupported objects, incompatible casts and cross-database relations
fail rather than silently transporting rows. Consult the upstream
[DuckDB conversion rules](https://www.duckdb.org/docs/current/clients/python/conversion).
On older CPUs use [Polars' `rtcompat` extra](https://docs.pola.rs/user-guide/installation/).
A native-library illegal instruction stops only that worker and reports the
CPU compatibility problem.

Python is an opaque lineage boundary. Duckpad does not invent cell mappings.
The lineage panel offers the captured parent results and lets you choose a
parent cell to resume SQL lineage. These refer to the generations used by that
Python execution, even after an upstream recalculation. Historical generations
are retained while a current Python output depends on them and released after
replacement; restarting a worker loses its in-memory results.

There is no Python-specific memory quota. DuckDB's memory setting does not cap
Python, pandas or Arrow allocations. Reserve memory for the API and other
workers; lower DuckDB's limit and execution concurrency accordingly. For example,
on an 8 GiB instance, start with one busy worker and a 2 GiB DuckDB limit, leaving
the rest for Python, the API, the OS and other services; measure your real flow
before increasing concurrency. Linux workers set `oom_score_adj=1000` before
confinement to prefer them during OOM selection, without guaranteeing API survival
under system-wide memory exhaustion. A worker crash, OOM, cancellation or timeout
invalidates that context; the next run recomputes it. Other contexts remain usable.

## Execution timeout and cancellation

Python nodes have no execution timeout by default, like SQL nodes: long API
pagination or pandas transformations run until they finish or a user cancels
the run.

Operators can set `DUCKPAD_PYTHON_TIMEOUT_SECONDS` to a positive number of
seconds (for example, `600`); unset or blank means no limit. The deadline applies
to each Python node's whole worker call: `run()`, DuckDB output materialization
(`CREATE TABLE … AS`), `self.check` validation and `write()`, not only time spent
in user code. It never applies to SQL nodes.

When it expires, the node fails and Duckpad stops the worker of that worktree and
environment. Every in-memory result of that context is lost, SQL results
included, and the next run recomputes them. External writes already started have
a partial or unknown outcome (see
[Checks, writes and artifacts](#checks-writes-and-artifacts)).

## Trust boundary

Python shares the existing SQL worker's filesystem policy. Isolated Linux mode
allows authorized data roots, temporary files and read-only runtime libraries;
project code cannot read the API metadata database or inherited API credentials.
Trusted local mode, including Windows, uses the same worker protocol without
Landlock and has the user's ordinary filesystem permissions. Process pipes work
on both platforms; no Linux namespace or kernel upgrade is required beyond the
existing isolated SQL requirements.

This is **not a hostile-code sandbox**. Network access and same-user process
signals are deliberately unconfined. Administrators must trust project editors
and dependencies. Enabling Python grants its code access to the secrets of all
connections authorized for this project: SQL and Python share worker memory.
`self.connection(self.api)` returns the selected authorized connection's settings,
including secret fields. It is a convenience API, not a boundary against memory
inspection. Secrets are never injected into environment variables. Exact secret
values are redacted from recorded messages; arbitrary encodings or external
exfiltration cannot be prevented. There is no HTTP credential proxy.

## Examples and performance check

- [GitHub releases](examples/python/github_releases.py): a real paginated API
  source with 10 records and a 2 MiB ceiling per page. Create a custom connector
  with `family: "database"`, empty `init_sql`, public text parameter `base_url`
  set to `https://api.github.com`, and optional secret `token`. Grant its
  connection to the project and select it in the node's `api` parameter. Public
  releases work without a token; authenticated requests use a granted connection containing the token.
  See [GitHub's release API](https://docs.github.com/en/rest/releases/releases).
- [Encoded ZIP](examples/python/encoded_zip.py): a SQL relation streamed to CSV,
  converted in 64 KiB character chunks to Windows-1252, then compressed into a
  managed download. Unrepresentable characters fail explicitly.
- `python scripts/benchmark_python.py --rows 1000000`: a reproducible
  SQL → Python relation filter → SQL aggregate run, reporting elapsed time and
  API/worker RSS. Environment installation is excluded. The reference budget is
  30 seconds and 512 MiB incremental RSS for this narrow three-column fixture;
  these are a regression check, not limits or promises for arbitrary Python.
