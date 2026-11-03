# Connections: design decisions

Implemented. The [connections guide](../CONNECTORS.md) documents configuration,
formats, database nodes and extension prerequisites. This record retains the
choices accepted on 1 November 2026; the original proposal is in Git history.

## Decisions

- A connection describes where data lives and how to reach it per environment.
  Credentials are optional: a granted server folder is also a connection.
- Project uploads and exports need no connection. Relative source paths resolve
  under project resources; destinations resolve under the worktree/environment
  export directory.
- File formats belong to nodes and project extension requirements. XLSX is not
  a connector. One storage location can serve several formats without duplicate
  connection configuration.
- Database connections attach an alias for generic Load table and Export table
  nodes. Writes remain explicit; connectors with another write protocol, such as
  OraDuck, keep their own export template.
- Connector types remain JSON definitions editable by instance administrators.
  Custom types declare the same database/storage family as built-ins.
- Built-ins follow the release until customized. An override survives upgrades;
  resetting removes only the override, while duplication creates a custom type.
- Format capabilities load through the project's Extensions tab and must already
  be installed by an administrator. Connector extensions install on first use
  from their declared repository or an offline import, in a child process.
  Runtime-linked extensions need neither.
- Test connection runs in a separate process so a native extension failure does
  not stop Duckpad.

## Alternatives considered

Requiring a Local workspace connection duplicated access already granted to a
project's own files. Separate connectors per format would multiply configuration
for each storage location. Template-level extension declarations would spread
project requirements across SQL files instead of keeping them in `extensions.json`.

Connector definitions stay JSON, without a form-based editor; typed connection
forms are generated from them. Systems without a compatible DuckDB
extension still need one rather than application-specific connector code.
