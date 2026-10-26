# Installation and accounts

## Start

Requires **Python 3.11+ and Git** on `PATH`. Shared SQL execution also requires **Linux with Landlock ABI 2 or later** (Linux 5.19+ with Landlock enabled); unsupported hosts refuse execution rather than running without isolation. Release wheels include the frontend, Monaco and its workers; Node.js is not needed to run the installed application.

```sh
pip install ./dist/duckpad-0.1.0-py3-none-any.whl
duckpad start
```

The distribution is named `duckpad`. Version tags publish the package to PyPI and create a GitHub release with Conventional Commit notes and downloadable distributions. After the first release, install it with `pip install duckpad`. See the [release guide](../docs/RELEASING.md) for one-time publishing setup and tagging instructions.

Open the localhost address printed in the terminal. Sign in as `admin` using the password printed **once** on the first launch. The same password remains valid after a restart. The default instance directory is `$XDG_DATA_HOME/duckpad`, or `~/.local/share/duckpad`. Authentication, connection settings and execution history are kept there, outside project repositories.

```sh
duckpad start --home /path/to/my-instance --port 8765 --no-browser
```

Only one backend may own an instance directory at a time. Use separate `--home` directories for independent instances. The default address is `127.0.0.1`. Behind an HTTPS reverse proxy, set `DUCKPAD_SECURE_COOKIES=1` so the session cookie is only sent over HTTPS.

Successful GET requests used for background polling (workspace, resources, worktree
snapshots, status, and generations) are logged at DEBUG. The default INFO level
still shows other requests, including failed polling requests. Use
`duckpad start --log-level debug` to include polling in the server logs.

## Accounts and project access

The initial `admin` account manages the instance. Open **Users** to create individual
accounts, reset passwords, change instance roles, or deactivate/reactivate accounts.
Passwords require at least 12 characters. Users can change their own password in
**Settings**; resets and deactivations revoke existing sessions.

- **Instance Admin** manages accounts, configuration, connections and every project.
- **Instance Member** sees only their projects and can create private projects.
  The creator becomes the project's admin.
- **Project Reader** can inspect the flow, SQL, history and existing results.
- **Project Editor** can also edit content, run/cancel pipelines and export through
  authorized connections.
- **Project Admin** can also manage participants and delete the project.

Open a project and select **Project settings** to add participants, change roles or
remove access. Every instance and project must retain an active admin. Instance
admins choose the connections authorized for each project on this screen. A project
admin cannot grant connections or promote an instance admin. Readers can copy data
they can see; read access is not an extraction restriction.

Existing installations preserve the original administrator password and assign
legacy projects to that account. Old sessions require a new sign-in. Memberships,
password hashes and connection grants remain in instance SQLite, outside project Git.
See [authorization and execution isolation](ARCHITECTURE.md#authorization-and-execution-isolation)
for deployment requirements and file access boundaries.

## Preferences and result lifetime

Instance admins can monitor server CPU and RAM in the workspace toolbar. Click
either indicator for two minutes of history; samples refresh every two seconds.
Measurements include the API process and its active SQL workers, with visible CPU
affinity and Linux cgroup limits taken into account. Missing measurements appear
as unavailable. History resets on reload or sign-out.

Language defaults to the first supported language in your browser preferences
(English or French, with English as the fallback), and the theme defaults to your
system color scheme. Manual choices are saved in this browser and take priority
on subsequent visits.

Results live in memory per worktree and environment. After a backend restart, history remains available but previews and lineage require another manual run. Editing or changing an external source does not launch a run automatically.
