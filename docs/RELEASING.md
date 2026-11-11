# Releasing Duckpad

Pushing a version tag starts `.github/workflows/release.yml`. The workflow validates
the tag, runs Python and browser checks, builds the frontend, and builds a source
archive and a wheel from that archive. It checks package metadata and smoke-tests
the installed wheel outside the checkout before publishing anything.

The validated distributions are published to PyPI through Trusted Publishing.
After PyPI succeeds, a GitHub release receives the same wheel and source archive,
a `SHA256SUMS` file, and Conventional Commit release notes. Regular branch pushes
and pull requests never publish packages. No version bump or Git tag is created
by the workflow.

The PyPI project page shows `README.md`. PyPI does not resolve relative links,
so the build points the README's repository links and images at the files of
the release tag; the smoke test rejects a description that keeps a relative one.
Keep links in `README.md` relative, as GitHub expects.

## One-time configuration

1. In the GitHub repository settings, create an environment named `pypi`. Allow
   deployment from version tags (`v*`). Configure required reviewers if the project
   needs an additional approval before publishing.
2. In PyPI, configure a [Trusted Publisher](https://docs.pypi.org/trusted-publishers/adding-a-publisher/)
   for the `duckpad` project with these values:

   | Field | Value |
   | --- | --- |
   | Owner | `hugues31` |
   | Repository | `duckpad` |
   | Workflow filename | `release.yml` |
   | Environment | `pypi` |

   For the first upload, use a [pending publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/)
   if the project does not exist yet. If the name already exists, the operator must
   have publishing rights to that project. No PyPI API token is required or stored
   in GitHub. The publishing job alone receives `id-token: write`; the GitHub release
   job alone receives `contents: write`.

Repository code cannot configure the PyPI account. Complete this setup before
pushing the first release tag.

## Publish a version

Replace `<version>` below with the package version from the approved commit.

1. Update `[project].version` in `pyproject.toml` and run `uv lock`. Use a release
   PR with a Conventional Commit title such as `chore(release): prepare <version>`.
   The frontend's private npm version is not the Python package version.
2. Review and merge the PR into `main`, following the project's approval workflow.
3. Tag the approved commit and push that specific tag:

   ```sh
   git fetch origin main --tags
   git tag -a "v<version>" <approved-commit> -m "Release Duckpad <version>"
   git push origin "v<version>"
   ```

Tags must exactly match `vMAJOR.MINOR.PATCH` and the package version. Pre-releases
append Python's canonical `aN`, `bN` or `rcN` suffix to that version, where `N`
is the prerelease number. They publish to PyPI and are
marked as pre-releases on GitHub, without replacing its latest stable release.
Other tag formats, mismatched versions, and commits outside `origin/main` fail
before publishing. Both annotated and lightweight tags are supported.

## Release notes

`git-cliff`, pinned in the development dependencies, parses Conventional Commits.
`cliff.toml` defines the presentation: installation command, breaking changes,
features, fixes, performance, documentation, reverts, maintenance, commit links,
and a full comparison link. Empty sections are omitted. Scopes are emphasized and
`BREAKING CHANGE:` / `BREAKING-CHANGE:` descriptions are shown as migration notes.
Use meaningful commit descriptions and explain breaking changes in the footer.

Routine chores, non-conventional messages and merge summaries are omitted;
original branch commits and breaking changes remain. A breaking merge summary
is omitted when its branch already records a breaking change in that release.
Stable and prerelease notes compare against the highest earlier stable version
among the tag's ancestors; the first release includes the full history.

Preview notes for work not yet tagged, without publishing. The preview starts from
the most recent stable tag reachable from `HEAD`, by commit date:

```sh
uv sync --locked
uv run git-cliff --offline --no-exec --unreleased --tag "v<version>" --output release-notes.md
```

To reproduce the exact workflow output from a release checkout:

```sh
uv run python scripts/release.py "v<version>" --output release-notes.md
```

Generated notes are build artifacts, not committed changelog files.

## Failure recovery

- If validation or tests fail, nothing is published. Correct the release through
  review before tagging the corrected version.
- If PyPI rejects authentication, check the four Trusted Publisher fields and
  the GitHub environment. Re-run failed jobs after fixing the configuration.
- If only the GitHub release job fails, use **Re-run failed jobs** on the original
  run. Its retained artifact contains the exact distributions already on PyPI.
  Do not rebuild or re-run a successful PyPI job.
- A partially successful PyPI upload needs operator inspection: compare the
  uploaded files with the retained artifact before completing the missing upload.
  The workflow deliberately does not silently skip existing files.
- Published PyPI versions cannot be overwritten. Never move a published tag or
  replace its release assets. Corrections require a new reviewed version and tag.

PyPI publication and GitHub release creation are separate operations, so inspect
both destinations after a successful run. Keep the `release-bundle` Actions
artifact until the release is verified; it is subject to the repository's artifact
retention policy.
