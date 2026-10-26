"""Verify the public frontend and authentication boundary after deployment."""

import sys
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/")
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
