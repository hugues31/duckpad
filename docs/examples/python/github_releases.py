"""Paginated GitHub source. Configure an authorized connection with a base_url value."""

import json
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

import duckpad as dp


class GitHubReleases(dp.Node):
    """Read public releases, one bounded response at a time."""

    api: dp.Connection
    repository: str = "duckdb/duckdb"
    pages: int = dp.param(default=2, ge=1, le=20)

    def run(self) -> dp.Relation:
        settings = self.connection(self.api)
        base = settings["base_url"].rstrip("/")
        headers = {"Accept": "application/vnd.github+json", "User-Agent": "Duckpad-release-example"}
        if settings.get("token"):
            headers["Authorization"] = "Bearer " + settings["token"]
        self.db.execute(
            "CREATE OR REPLACE TEMP TABLE github_releases (tag VARCHAR, published VARCHAR, url VARCHAR)"
        ).complete()
        for page in range(1, self.pages + 1):
            endpoint = f"{base}/repos/{quote(self.repository, safe='/')}/releases?{urlencode({'per_page': 10, 'page': page})}"
            with urlopen(Request(endpoint, headers=headers), timeout=20) as response:
                body = response.read(2 * 1024 * 1024 + 1)
            if len(body) > 2 * 1024 * 1024:
                raise ValueError("GitHub page exceeds the 2 MiB example limit")
            releases = json.loads(body)
            if not releases:
                break
            self.db.executemany(
                "INSERT INTO github_releases VALUES (?, ?, ?)",
                [(r["tag_name"], r["published_at"], r["html_url"]) for r in releases],
            ).complete()
            self.message("info", f"Read page {page}: {len(releases)} releases")
        return self.db.table("github_releases")
