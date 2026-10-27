# Your first pipeline

Go from a fresh install to a result you can explain. The included **Northstar**
project provides synthetic CSV and Parquet data, reusable transformations and
exports. You do not need an external database account.

## 1. Start Duckpad

You need **Python 3.11+** and **Git**. The package includes the interface;
you do not need Node.js or a source checkout.
SQL execution requires **Linux with Landlock ABI 2 or later** (Linux 5.19+ with
Landlock enabled). A Linux container or VM must also expose this capability.

```sh
pip install duckpad
duckpad start
```

Open the local address printed in the terminal, normally `http://127.0.0.1:8765`.
Sign in as **admin** using the password printed once on first launch. Save it
somewhere private; the same password remains valid after a restart.

See [installation and accounts](INSTALLATION.md) for instance options,
virtual environments and development from source.

## 2. Open the example

Choose **Open example project** on the welcome screen. Keep the **dev**
environment selected and click **Run pipeline**. Wait for the run to finish.
This reads 120 orders and 12 customers, joins them and writes two local CSV reports.

![The Northstar pipeline and its revenue preview](images/workspace.png)

Select **Regional revenue** on the canvas and choose **report** in the output
selector. The table shows the calculated revenue for each region.

## 3. Explain a number

Click a **revenue** cell in the result table. The lineage timeline follows the
rank step into the aggregate automatically, keeping the selected value visible.
Choose an **amount** to follow its path to the original source row. Use **Next**
to page through groups of five contributions, or select an earlier timeline step
to explore another input. **Play this path** animates the explored steps from the
source toward the selected value; use **Pause** to inspect a step.

![The original amounts behind a regional revenue total](images/lineage.png)

An explanation describes the data captured by that run. It does not silently
read a changed source file. See [lineage coverage](LINEAGE.md) for supported SQL
and explicit limitations.

## 4. Make it yours

Select **Paid orders** and change its **status** parameter. The old preview
becomes **Stale**. Click **Run pipeline** again to compute the new result.
You choose when a run happens; editing never starts one automatically.

Try the **Code** tab to inspect the project files and SQL. Use **New working
branch** before experimenting with a shared definition, then compare your changes
before merging them. The [version control guide](GIT.md) explains the full review
workflow.

## Where next?

- Follow the [Northstar tour](EXAMPLE.md) for nested components and environment comparisons.
- Learn the [pipeline and SQL template contract](AUTHORING.md).
- Configure your own [connections](CONNECTORS.md).
- Invite your team with [accounts and project roles](INSTALLATION.md#accounts-and-project-access).

## If something gets in the way

- **An unsupported sandbox error:** check that the Linux kernel exposes Landlock
  ABI 2+. Duckpad refuses SQL execution without its isolation boundary.
- **An instance is already running:** stop the original process or use a different
  `--home` directory and `--port` for a second instance.
- **A blank or stale preview after restart:** run the pipeline again. Execution
  history persists; materialized results and lineage live in memory.
- **A build error on an older CPU:** the deployment guide describes the optional
  portable DuckDB runtime. Keep DuckDB 2.0; do not downgrade to bypass setup.
