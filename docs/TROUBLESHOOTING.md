# Troubleshooting

Start with the node's **Log** for a failed run, or **History** for the full
execution. Check the project, branch and environment: each can show different
data. The inspector's SQL tab shows the current configuration; **Log → Executed
SQL** shows the statements and values used by that run.

## Start and sign in

| Symptom | Next step |
| --- | --- |
| `duckpad` is not found after installation | Activate the Python environment where you installed it, then run `duckpad start` again. See [installation](INSTALLATION.md#start). |
| Execution reports "Shared SQL execution requires … Landlock ABI 2 or later" | Check Linux and Landlock requirements in [installation](INSTALLATION.md#start). A trusted macOS or Windows workstation can explicitly use [trusted local mode](INSTALLATION.md#trusted-local-mode); shared instances need isolation. |
| The instance is already running | Use the existing server, or stop it before restarting. Independent instances need different `--home` directories and ports. |
| I lost my password | Ask an instance administrator to reset it in **Instance settings → Users and permissions**. Single sign-on accounts change it with their identity provider. The initial password is printed only on the first launch; restarting does not reveal or replace it. |
| Sign-in is temporarily blocked | Wait for the one-minute rate-limit window. If everyone behind a proxy is affected, ask the operator to check [forwarded client addresses](INSTALLATION.md#reverse-proxy). |
| An upgrade rejects the storage schema | Keep the old instance directory and follow the [fresh-instance migration instructions](INSTALLATION.md#upgrades-and-backups). Do not delete the old database to get past the error. |

## Find and read data

| Symptom | Next step |
| --- | --- |
| A file on my computer is not found | Upload it through **Project files**. A server-folder path is resolved on the server. Follow [Use your own data](YOUR_DATA.md). |
| A connection is missing from the selector | Check that an instance admin granted it to this project. **Load table** offers database connections; file nodes offer storage locations. [Connection setup](CONNECTORS.md#configure-and-grant-a-connection) explains both. |
| A connection works in dev but fails in prod | Each environment has its own connection values; values entered for dev are not copied to prod. Ask an admin to configure and **Test connection** for prod. |
| CSV identifiers lose zeros, or a conversion fails | Set the affected column's type in the source preview; use `VARCHAR` for identifiers. Check delimiter and header before setting overrides. |
| An XLSX node reports a missing function or extension | Enable `excel` in **Project settings → Extensions**. If unavailable, an instance admin must install/import a binary for the server's DuckDB version and platform. See [extensions](OFFLINE_EXTENSIONS.md). |
| A project ZIP opens but its sources do not | ZIPs contain definitions, not uploaded data or connection settings. Upload the source files and obtain the required grants on this instance. See [project imports](AUTHORING.md#edit-and-share-project-files). |

## Save and run

| Symptom | Next step |
| --- | --- |
| A run refuses to start because an input is missing | Connect every required input. For an inline SQL source, remove the default `-- @input source` declaration when you replace its code. |
| A save fails, or the top bar stays on Unsaved changes | Return to the edited field or code file and read its error. Correct it and save again before running. If another edit conflicts, use the [conflict review](GIT.md#concurrent-saves). |
| SQL reports "Undeclared, self or forward reference" | Match a declared input, parameter or earlier output exactly. Reference the declared input port, not the upstream node's canvas name. See [SQL diagnostics](SQL.md#diagnose-a-node). |
| A test fails even though its count is zero | Return the failing rows, not `SELECT COUNT(*)`. A count query returns one row and therefore fails a data test. See [data tests](TESTS.md#failing-rows-not-counts). |
| An action is absent or disabled | Check your [project role](INSTALLATION.md#accounts-and-project-access). Readers inspect; Operators run Jobs; Editors can edit and run working branches. Comparisons and Job result checkouts are read-only; open an earlier revision in a new branch to edit it. |
| A branch or Job is busy | Wait for its active run to finish, or cancel it if you have permission. Cancellation must finish before a new launch; rejected launches are not queued. |

## Understand the result

| Symptom | Next step |
| --- | --- |
| Results are empty after restarting | Run the branch again in the selected environment. History persists, but in-memory tables need recomputing. See [result lifetime](RESULTS.md#result-lifetime). |
| Old rows remain after a failed run | They are the previous successful result, marked **Stale**. Read the latest error in Log, fix it and rerun. They are not a successful result of the failed attempt. |
| Changing a source file did not change the rows | Run again to read the source. Source changes do not trigger execution. |
| A filtered table exports extra rows | A result sample only affects the display. Add a Filter node before the export to change the pipeline's rows. |
| A cell cannot be explained | Use a valid result, then check [lineage coverage](LINEAGE.md#explicit-limitations). Unsupported SQL can execute successfully without a complete explanation. |
| Download exported data is missing or disabled | Select a supported local CSV/XLSX export in the right environment and run it successfully. See [download availability](RESULTS.md#download-exported-data). |

For network Git failures, see [Git credentials](GIT.md#network-credentials).
For provider errors, see [assistant troubleshooting](ASSISTANT.md#troubleshoot-provider-failures).

## Ask for help

Give your administrator, or a [GitHub issue](https://github.com/hugues31/duckpad/issues),
the Duckpad version, the action you took, the exact error and a small synthetic
example that reproduces it. Mention the selected environment and whether it
happens on a working branch or a Job. Remove credentials, private server
addresses and business data from logs, SQL and screenshots before sharing them.
