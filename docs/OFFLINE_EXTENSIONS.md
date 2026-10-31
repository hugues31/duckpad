# DuckDB extensions without Internet access

**Download on any connected computer, then import the file into Duckpad.**
A Windows PC can download extensions for a Linux server. The downloading computer
does not need DuckDB, Python, Linux, or a prepared extension cache.

## Download, transfer, import

1. Open **Instance settings → Extensions** as an administrator.
   Choose **DuckDB core** or **DuckDB community**, enter the extension name, and
   click **Download server binary** on a computer with Internet access.
   The link uses the **server's version and platform**, not your PC's.
2. Transfer the downloaded file if necessary. In the same settings panel, choose
   the matching source, select the `.duckdb_extension.gz` or `.duckdb_extension`
   file, and click **Import extension**. Keep the original filename.
3. Configure the connector and connection under **Instance settings → Connections**,
   grant the connection to the project, and run your pipeline.

![Extension settings show the server runtime, binary download link, file import and unsigned-build policy](images/extensions.png)

Duckpad decompresses the file, checks its version, platform and signature, and
installs it locally. **The server needs no Internet connection or restart.**
The browser must be able to reach Duckpad to upload the file.

For example, a Windows browser connected to a Linux x86-64 server running DuckDB
2.0.0 receives a link containing `v2.0.0/linux_amd64`, even though the browser runs
on Windows. Use this same process for each extension your connectors need.

## Before importing

- Stop active runs. A successful import replaces that extension for the instance
  and clears current results; run your pipelines again.
- Files may be up to **64 MiB** (256 MiB after decompression). A `.gz` file can be
  imported directly. For a `.tar.gz` or `.zip` release, extract it on any computer
  and select the binary for the server's version and platform.
- Import extension dependencies separately. Native client libraries and CPU
  compatibility still depend on the server; see [connector prerequisites](CONNECTORS.md).

Signed core and community imports keep signature verification enabled. Use
**Custom / unsigned builds** only for a trusted binary outside those signing
keys, after enabling **Allow unsigned extensions** in the same **Extensions** tab.
This setting is off by default.

See [download links, checks and troubleshooting](OFFLINE_EXTENSIONS_ADMIN.md)
for manual downloads, API use and installation details.
