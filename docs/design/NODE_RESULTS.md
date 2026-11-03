# Node results: design decisions

Implemented. See [Results, samples and logs](../RESULTS.md) for the current
interface and file format. These choices were accepted on 31 October 2026;
the original proposal and mockups remain in Git history.

## Alternatives considered

- **Keep run outcomes in the inspector and add tabs there.** Rejected: the inspector is narrow (260 to 560 px), rows and logs need width, and it would keep mixing definition and outcome.
- **Samples that drive downstream computation.** Rejected: displayed samples
  must not change the meaning of a full-data result. A sampled execution mode
  would need its own validity and lineage rules.
- **Column statistics computed when the Columns tab opens**, or only below a size threshold. Rejected (decision 3): the cost grows with the result's size and width and competes with runs, while names, types and descriptions, the common need, cost nothing.
- **Storing failing rows** (dbt `--store-failures`). Rejected: memory and privacy costs, and stored rows go out of date; retained results already allow an exact recomputation.
- **A free SQL console in the panel.** Deferred: **Copy SQL**, **Add as a Filter node** and a SQL node on a branch cover the need with lineage and history.
- **Views in `documentation.json`.** Rejected: views are not documentation; a dedicated file keeps diffs and merges readable.

## Decisions

Decided on 31 October 2026:

1. **A sample acts only on the display.** Runs always compute on full data; a sampled development run, if needed, gets its own design.
2. **Shared views in the project** (`views.json`), in addition to personal samples remembered in the browser.
3. **Dataset and column descriptions are edited from the Columns tab.** Names, types and descriptions show at once; column statistics are computed only with **Compute statistics**.
