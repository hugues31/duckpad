# DuckDB extensions without Internet access

Install a prepared extension cache once, then use your usual Duckpad connections.
**OraDuck is available signed**; keep **Allow unsigned extensions** disabled for
this procedure.

## Quick install: extract the cache and restart

1. Obtain `duckpad-extensions.tar.gz`, prepared for the backend's DuckDB version
   and platform using the [one-time preparation recipe](OFFLINE_EXTENSIONS_ADMIN.md#prepare-a-cache-archive).
2. Stop Duckpad. As the backend service user, extract the archive into the
   **instance directory** and restart:

   ```sh
   export DUCKPAD_INSTANCE=/path/to/instance
   tar --no-same-owner -xzf duckpad-extensions.tar.gz -C "$DUCKPAD_INSTANCE"
   duckpad start --home "$DUCKPAD_INSTANCE" --no-browser
   ```

3. Configure the connection in **Instance settings → Connections**, grant it to
   the project, and run the pipeline. For Oracle, use the existing Oracle preset.

The instance directory is the one passed to `--home`; the default is
`$XDG_DATA_HOME/duckpad` or `~/.local/share/duckpad`. In a container, extract into
the persistent volume used by that instance. Back up an existing cache before
replacing it.

The prepared archive contains `extensions/`, so extraction puts files here:

```text
<instance>/extensions/v2.0.0/linux_amd64/
├── oraduck.duckdb_extension
└── oraduck.duckdb_extension.info
```

Keep the binary and its `.info` file together. **Extract the archive:** Duckpad
does not automatically unpack a `.tar.gz` dropped into a folder.

## Which OraDuck download?

The [OraDuck v0.4.0 release](https://github.com/hugues31/oraduck/releases/tag/v0.4.0)
now offers **`oraduck-signed-repository.tar.gz`** and its `.sha256` checksum.
The original `oraduck-repository.tar.gz` remains unsigned.

The signed GitHub archive is a **DuckDB repository**, containing compressed
binaries and signing keys. It is not the prepared Duckpad cache used above:
extracting it into `extensions/` is insufficient. For Duckpad's standard Oracle
connector, prepare the cache once with `INSTALL oraduck FROM community`, as shown
in the [administrator recipe](OFFLINE_EXTENSIONS_ADMIN.md#prepare-a-cache-archive).

Oracle Instant Client 19+ and its system libraries must also be installed on the
backend. See [Oracle prerequisites](CONNECTORS.md#oracle--oraduck).

## Other extensions and troubleshooting

The same cache method works for other signed extensions. Match DuckDB's version
and platform, preserve installation metadata, and restart after replacing files.
See [preparation, checks and troubleshooting](OFFLINE_EXTENSIONS_ADMIN.md).

For a trusted unsigned custom build, an administrator can enable
**Instance settings → General → DuckDB extensions → Allow unsigned extensions**.
This disables signature checks for the instance; changing it requires stopping
active runs and clears current results. It is unnecessary for signed OraDuck.
