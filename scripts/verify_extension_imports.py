"""Verify real core/community file imports with all networking disabled."""

import argparse
import gzip
import json
import socket
import tempfile
from datetime import UTC, datetime
from pathlib import Path

from fastapi.testclient import TestClient
from verify_offline_extensions import verify_duckpad

from duckpad.app import create_app
from duckpad.extensions import runtime


def verify(community, core, wrong_platform):
    assert [name for _, name in socket.if_nameindex()] == ["lo"], "Use an isolated network namespace"
    version, platform = runtime()
    report = {
        "verified_at": datetime.now(UTC).isoformat(),
        "version": version,
        "platform": platform,
        "checks": [],
    }
    original = gzip.decompress(community.read_bytes())
    damaged = original[:-1] + bytes([original[-1] ^ 1])
    with tempfile.TemporaryDirectory(prefix="duckpad-import-check-") as temporary:
        root = Path(temporary)
        app = create_app(root / "api", watch=False)
        with TestClient(app) as client:
            client.post("/api/login", json={"password": app.state.auth.initial_password})

            def upload(filename, content, source="community"):
                return client.post(
                    "/api/extensions/import", data={"source": source}, files={"file": (filename, content)}
                )

            assert upload("h3.duckdb_extension.gz", community.read_bytes()).status_code == 200
            assert upload("httpfs.duckdb_extension.gz", core.read_bytes(), "core").status_code == 200
            assert upload("h3.duckdb_extension", original).status_code == 200
            report["checks"].append("signed_core_and_community_imports_compressed_and_raw")
            baseline = client.get("/api/extensions/runtime").json()
            for content, expected in [
                (gzip.compress(damaged), "signature"),
                (wrong_platform.read_bytes(), "platform"),
            ]:
                response = upload("h3.duckdb_extension.gz", content)
                assert response.status_code == 400 and expected in response.json()["error"].lower(), (
                    response.text
                )
                assert client.get("/api/extensions/runtime").json() == baseline
            report["checks"].append("damaged_signature_and_wrong_platform_preserve_previous_import")
            # H3 uses the stable C ABI: its required ABI version is a footer field,
            # distinct from the DuckDB release used in the download URL.
            assert original[-352:-320].startswith(b"v")
            changed = original[:-352] + b"v9.9.9".ljust(32, b"\0") + original[-320:]
            response = upload("h3.duckdb_extension.gz", gzip.compress(changed))
            assert response.status_code == 400 and "version" in response.json()["error"].lower(), (
                response.text
            )
            report["checks"].append("unsupported_abi_version_rejected")
            assert upload("h3.duckdb_extension.gz", gzip.compress(damaged), "unsigned").status_code == 400
            client.put("/api/extensions/settings", json={"allow_unsigned_extensions": True})
            assert upload("h3.duckdb_extension.gz", gzip.compress(damaged)).status_code == 400
            assert upload("h3.duckdb_extension.gz", gzip.compress(damaged), "unsigned").status_code == 200
            report["checks"].append("unsigned_import_requires_explicit_policy_and_source")
        tampered = root / "h3.duckdb_extension.gz"
        tampered.write_bytes(gzip.compress(damaged))
        for isolated in (False, True):
            mode = "isolated" if isolated else "embedded"
            verify_duckpad(root / mode, None, isolated, import_file=community)
            report["checks"].append(f"{mode}_imported_pipeline_after_two_reopens")
            verify_duckpad(root / (mode + "-unsigned"), None, isolated, True, import_file=tampered)
            report["checks"].append(f"{mode}_unsigned_import_revoked_after_policy_change")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("community", type=Path, help="H3 .gz binary for the current Linux platform")
    parser.add_argument("core", type=Path, help="httpfs .gz binary for the current Linux platform")
    parser.add_argument("wrong_platform", type=Path, help="H3 .gz binary for Windows")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = verify(args.community.resolve(), args.core.resolve(), args.wrong_platform.resolve())
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
