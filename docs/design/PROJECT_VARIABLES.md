# Project variables: design decisions

Ordinary variables, expression references, computed variables and path references
are implemented. See [Project variables](../VARIABLES.md) for usage and formats.
This record preserves the decisions behind the implementation; the original
proposal and mockups remain in Git history.

## Decisions

- Ordinary values are versioned per project and environment. Instance-local
  overrides would hide changes from review and merge.
- References belong to root instances. Components expose parameters so imported
  definitions do not depend on the source project's variable names.
- Expressions bind typed values; paths use a separate renderer and authorization
  check. Unrestricted textual substitution would lose type and quoting guarantees.
- The Variables workspace tab edits declarations; it is not instance configuration.

## Computed variables

Accepted on 1 November 2026. A versioned `{node, port?, column}` source supplies
exactly one non-null, losslessly converted value. It cannot also declare a default
or environment override. Producers use ordinary variables only, preventing
computed chains and cycles.

Included producers run in a value phase before consumers. Excluded producers use
retained values from the same worktree/environment, with their producing run and
commit recorded. Compilation and preview never execute a producer. A failed
refresh cannot substitute an older value within that run; a canceled value phase
publishes no partial values.

Values stay in execution contexts and history, never in `variables.json`.
Partitions reuse source selection, typed values and execution phases, while adding
multi-row manifests and per-key state rather than mutating scalar variables in a loop.

## Alternatives considered

Instance-wide business variables and interpolation in arbitrary text remain
unimplemented. Connections already hold environment-specific infrastructure
configuration. Caller-supplied values need separate precedence and authorization
rules; they remain part of the [automation proposal](JOB_AUTOMATION.md#delivery-plan),
not a fallback for computed declarations.
