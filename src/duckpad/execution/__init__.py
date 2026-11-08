"""Services behind the execution engine facade.

`contexts` owns the live DuckDB contexts and their SQL workers, and `connections` the access
and setup of their connections. `runs` admits, cancels and orchestrates runs: `launches`
prepares them, `nodes` and `python_nodes` execute their nodes, `values` freezes computed
variables, `publication` publishes and retires results, and `journal` persists run records.
`exports` tracks exported files and their downloadable copies, `results` serves previews and
compiled SQL, and `fingerprints` decides which results are still current.
"""
