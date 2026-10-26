"""Verify the public frontend and authentication boundary after deployment."""

import argparse
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse


def wait_for_deployment(base, commit):
    hostname = urlparse(base).hostname or ""
    suffix = ".app.example.invalid"
    if not hostname.endswith(suffix):
        raise SystemExit("Commit verification is only configured for the server's preview domain.")
    token = os.environ.get("COOLIFY_TOKEN")
    if not token:
        token = (Path.home() / ".coolify/multica-token").read_text().strip()

    def api(path):
        request = urllib.request.Request(
            "https://coolify.example.invalid/api/v1" + path,
            headers={"Authorization": "Bearer " + token},
        )
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.load(response)

    name = "preview-" + hostname.removesuffix(suffix)
    application = next((item for item in api("/applications") if item.get("name") == name), None)
    if not application:
        raise SystemExit(f"No Coolify application exists for {name}.")
    deadline = time.monotonic() + int(os.environ.get("PREVIEW_TIMEOUT", "1200"))
    while time.monotonic() < deadline:
        deployments = api("/deployments/applications/" + application["uuid"])
        if isinstance(deployments, dict):
            deployments = deployments.get("deployments", [])
        latest = deployments[0] if deployments else {}
        if latest.get("commit") == commit:
            status = latest.get("status")
            if status == "finished":
                print(f"Coolify finished deployment of {commit}.")
                return
            if status in ("failed", "cancelled", "canceled"):
                raise SystemExit(f"Coolify deployment of {commit} {status}.")
        time.sleep(10)
    raise SystemExit(f"No finished deployment of {commit}; the URL may still serve an earlier version.")


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("url")
parser.add_argument("--commit", help="Wait for Coolify to finish deploying this exact Git commit")
args = parser.parse_args()
base = args.url.rstrip("/")
if args.commit:
    wait_for_deployment(base, args.commit)
with urllib.request.urlopen(base + "/", timeout=20) as response:
    html = response.read().decode()
    if response.status != 200 or '<div id="root"></div>' not in html or "/assets/" not in html:
        raise SystemExit("The preview is not serving the built Duckpad frontend.")
try:
    urllib.request.urlopen(base + "/api/session", timeout=20)
except urllib.error.HTTPError as error:
    if error.code != 401:
        raise SystemExit(f"Expected authentication protection, received HTTP {error.code}.") from error
else:
    raise SystemExit("The preview unexpectedly allows unauthenticated API access.")
print(f"Verified Duckpad frontend and authentication: {base}")
