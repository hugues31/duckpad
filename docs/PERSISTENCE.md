# Settings persistence and migrations

Duckpad stores instance configuration in SQLite and browser preferences in Web
Storage. Project definitions live in Git, while computed datasets live in memory.
Changing a setting does not automatically synchronize it across these stores.

## What is stored where?

| Data | Storage | Scope and lifetime |
| --- | --- | --- |
| Shared Git author name/email, environment names, OIDC configuration | `instance.sqlite`, `settings` records | Instance-wide; survives backend restarts when the same instance directory is retained. |
| Connector definitions and connection values for each environment | SQLite, `connector` and `connection` records | Instance-wide, with project connection grants controlling access. Not versioned with project code. |
| Accounts, password hashes and sessions | SQLite, `user` and `session` records | Accounts persist; sessions expire or are revoked. The browser holds the session token in an HttpOnly cookie. |
| Project participants, roles and authorized connections | SQLite, `access` records keyed by project | Shared by the project's branches; outside project Git history. |
| Project/worktree registry, execution history and conflict/review records | SQLite | Durable instance metadata, separate from the actual project files and computed rows. |
| Git remote URL and branch mappings | SQLite, `git_remote` records, plus the repository's local Git configuration | Per project; not part of versioned pipeline files. Git credentials use the server's Git/SSH configuration. |
| Language, theme, last opened worktree, panel sizes | Browser `localStorage` | Per browser profile and origin; shared by accounts using that profile and origin. No server or cross-device synchronization. |
| Git comparison selections and filters | Browser `sessionStorage` | Per origin and browser tab session; survives a reload. |
| Pipeline graph, node parameters/layout, SQL templates, components and documentation | Project files and Git commits | Per project branch; saved changes have Git history. |
| Computed datasets and live preview/lineage state | DuckDB worker memory | Per worktree and environment; requires another manual run after backend restart or context eviction. |

The settings UI is organized by authorization scope, not by storage technology.
For example, **User settings** changes the account password on the server but saves
language and theme only in the browser. **Project settings** changes access records
in SQLite, not files in the project's Git repository. See
[settings scopes](ARCHITECTURE.md#settings-scopes) for permissions and entry points.

## SQLite and instance files

The instance directory is selected with `duckpad start --home`; its default is
`$XDG_DATA_HOME/duckpad`, or `~/.local/share/duckpad`. `src/duckpad/store.py` opens
`instance.sqlite` in WAL mode and creates one generic table:

```sql
CREATE TABLE IF NOT EXISTS records (
    kind TEXT,
    id TEXT,
    value TEXT,
    PRIMARY KEY (kind, id)
);
```

`value` contains JSON. For example, the Git author is stored under
`(kind="settings", id="identity")`, environments under `("settings", "environments")`,
and OIDC configuration under `("settings", "oidc")`. Each `Store.put` replaces and
commits one record. SQLite does not validate the structure of these JSON values;
their shape is defined by the application code. Changing that shape may require a
data migration even when the SQL table stays identical.

The database uses file permissions `0600`; a newly created instance directory uses
`0700`. Local account passwords are stored as salted scrypt hashes and session
tokens as hashes. Connection secrets and the OIDC client secret, however, are
stored as recoverable values in SQLite, without application-level encryption.
Masking them in API responses is distinct from encryption at rest.

Retaining this directory preserves server settings across restarts. A fresh
`--home` starts a separate instance; replacing a container without retaining its
data directory loses its instance state. Git cloning alone does not restore
accounts, connections, access grants or execution history. Re-running historical
project code uses the current instance connections and environment configuration.

## Browser storage

The current keys are:

| Storage | Key | Value |
| --- | --- | --- |
| `localStorage` | `duckpad-language` | An explicit `en` or `fr` choice. Without a valid saved choice, use the first supported browser language, falling back to English. |
| `localStorage` | `duckpad-theme` | An explicit `light` or `dark` choice. Without a valid saved choice, use the system color scheme when initializing the UI. |
| `localStorage` | `duckpad-worktree` | Last opened worktree ID. If it is absent from the signed-in account's workspace, the UI clears it and opens the project dashboard. |
| `localStorage` | `duckpad-panel-sizes` | JSON with palette/inspector widths and preview height. Invalid values are ignored; sizes are constrained to the viewport. |
| `sessionStorage` | `duckpad.git.<worktree>` | Git comparison references `a` and `b`. |
| `sessionStorage` | `duckpad.git.<worktree>.filters`, `.publishFilters`, `.reviewFilters` | Comparison filter JSON: changed-only selection, category and search text. |

The selected run environment and most navigation state remain React state, so
they are not restored from browser storage after a full reload. The configured
environment list is a separate, persistent SQLite setting.

Browser storage is scoped by origin (scheme, host and port). A new origin or
browser profile has separate preferences; clearing site storage removes them.
`localStorage` normally survives browser restarts, while `sessionStorage` belongs
to the tab session. These preferences do not contain Duckpad authentication tokens
or connector credentials. See MDN's
[`localStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)
and [`sessionStorage`](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)
references for browser lifecycle details.

## Migrations that exist today

There is no central schema-version counter, ordered migration runner or downgrade
command. Startup creates the SQL table if absent; `CREATE TABLE IF NOT EXISTS`
does not upgrade an existing table. Neither the SQLite records nor browser
preferences have a general format version. Application release versions and
session revocation versions do not serve that purpose.

There are already targeted compatibility conversions at startup:

- `Auth.__init__` in `src/duckpad/auth.py` converts the legacy `auth/admin` password
  hash into an individual `user/admin` account when no accounts exist, then removes
  the legacy record. The password remains valid; old sessions without an account
  owner are rejected.
- `Access.__init__` in `src/duckpad/access.py` assigns legacy projects to the
  original administrator and grants their existing connections once, guarded by
  `settings/access_migrated`.
- `Catalog.__init__` in `src/duckpad/catalog.py` fills missing `secret_fields` on
  connection records. `settings/catalog_initialized` separately marks initial
  catalog seeding; it is not a schema version and does not refresh presets on
  every upgrade.

These conversions are distributed across services and are not one atomic,
versioned upgrade. Browser readers provide defaults for some missing or invalid
values, but there is no browser migration registry. Restart recovery that marks
unfinished runs interrupted is operational recovery, not a schema migration.

## A feasible versioned migration approach

Versioned migrations are feasible with the existing SQLite store. The following
is a proposed next step, not an implemented feature or a scheduled delivery:

1. Track an application-owned version with SQLite's
   [`PRAGMA user_version`](https://www.sqlite.org/pragma.html#pragma_user_version)
   or a dedicated migration table. Define how to recognize existing unversioned
   instances and their already-applied compatibility conversions.
2. Run ordered SQL and JSON transformations before constructing services or
   accepting requests. Commit each migration's changes and version together in
   an explicit transaction. The current per-record `Store.put` commits would
   need to participate in that transaction instead of committing independently.
3. Reject databases newer than the application supports. Test upgrades from old
   fixtures, repeated startup, failed-step rollback and preservation of secrets,
   IDs and access grants. Do not imply that an older application can safely open
   an upgraded database.
4. Version browser payloads separately if their structure changes, with explicit
   conversion and validated defaults. Treat project JSON formats as another
   compatibility boundary: a database migration cannot rewrite historical Git
   commits. Keep readers compatible or provide an explicit project upgrade.

Before an upgrade, stop the instance and back up the entire instance directory,
including project repositories, worktrees and resources. Restore it with the
matching application version and original paths; worktree metadata contains
paths. For a live database-only backup, use a SQLite-aware method such as the
[backup API](https://www.sqlite.org/backup.html), rather than copying only the
active WAL database file. That snapshot does not include project files or browser
preferences. Duckpad currently has no automatic backup or rollback command.
