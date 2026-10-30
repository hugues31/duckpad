"""Services behind the execution engine facade.

`contexts` owns the live DuckDB contexts and their SQL workers, `runs` admits and executes
runs, `exports` tracks exported files and their downloadable copies, `results` serves
previews and compiled SQL, and `fingerprints` decides which results are still current.
"""
