# Implementation tracking

SPEC.md remains the source of product requirements. This checklist links the delivered implementation to its validation, rather than replacing the specification.

- [x] Persistent authentication, instance catalog and packaged CLI
- [x] Declarative project files, automatic Git saves and external batching
- [x] Field-level edit conflicts, isolated branches and validated merges
- [x] Typed SQL templates and declarative connectors
- [x] Atomic execution admission, immutable snapshots, cancellation and durable history
- [x] Atomic output publication, invalidation and retained previews
- [x] Cell, column and table lineage for the extended baseline; explicit broader limitations in LINEAGE.md
- [x] Nested components, exposed parameters and independent imports
- [x] React Flow canvas, Monaco, guided/typed forms, preview and lineage navigation
- [x] English/French localization, light/dark theme and business documentation
- [x] Complete Northstar example with separate development/production inputs
- [x] 66 Python acceptance tests and eight regularly exercised Playwright scenarios
- [x] Execution-service prototype comparison, with recorded results
- [x] Million-row, fifty-column benchmark and native value comparison
- [x] Live Oracle/OraDuck read/write/refresh validation and local S3 emulator validation
- [x] Release wheel/source distribution and isolated wheel installation/restart smoke test
- [x] CI configuration for Python 3.11/3.13, frontend build and browser acceptance

See VALIDATION.md for commands and measured results, CONNECTORS.md for tested platforms and external prerequisites, and LINEAGE.md for SQL constructs outside exact provenance coverage. Scheduled runs and webhooks remain post-MVP, as specified. No package-index publication is performed by this repository task.
