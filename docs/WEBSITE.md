# Website and documentation

The site in `website/` uses **Astro 7** to emit static HTML. Its small browser
scripts handle theme choice, code copying and documentation search. Fonts are
self-hosted; videos load only on request. Navigation, content and links work
without JavaScript. Motion respects `prefers-reduced-motion` and native page
transitions progressively enhance supported browsers.

## Work on the site

Use **Node.js 22.23.4+**. From the repository root:

```sh
npm ci --prefix website
npm run dev --prefix website
```

Astro loads the public guides directly from `docs/`. Edit those Markdown files
instead of maintaining a second copy. Register new guides in
`website/src/content.config.ts` and `website/src/lib/docs.ts` so navigation,
search and page generation stay in sync. Relative Markdown links are rewritten
at build time; the same source remains readable on GitHub. Internal operator
documentation is excluded from the public site's collection.

```sh
npm run check --prefix website
npm run build --prefix website
npm run preview --prefix website
```

`WEBSITE_BASE_PATH` controls the deployment prefix (default `/`). `SITE_ORIGIN`
optionally supplies the public canonical origin; leave it unset for private
previews. The built site is in `website/dist/`. The application image also serves
a separately built copy under `/site/` so a ticket preview includes the website.

## Release notes

The `/releases/` page and static `/releases.json` feed retrieve published versions
from the GitHub Releases API during the build. Notes are rendered as sanitized
Markdown, ordered by publication date, with pre-releases labeled separately.
Drafts and API metadata are excluded. Browsers receive only static content;
no GitHub credential or client-side API request is needed.

CI uses its read-only `GITHUB_TOKEN` to read releases while the repository is
private. An authenticated API failure fails the build. Without a token, an API
failure uses the bundled `website/src/data/releases.json` snapshot so local and
container builds remain usable offline or while the repository is private.
Refresh that snapshot before shipping a preview with new release notes:

```sh
npm run releases:update --prefix website
```

For a private repository, supply `GITHUB_TOKEN` through your shell's secret
manager. Never commit it or pass it to browser code. The website workflow also
runs after a successful **Release Duckpad** workflow, since releases created by
`GITHUB_TOKEN` do not themselves trigger other release workflows. This rebuilds
the site from `main` after publication completes. After manually editing or
deleting release notes, run the website workflow with `workflow_dispatch`.

## Regenerate the demonstrations

The recorder drives the **real Duckpad application**, using the built-in Northstar
fixtures and a disposable local instance. It checks the pipeline result and
lineage before saving media. A visible pointer follows mouse movement and clicks.
Captions explain each step, and the written Northstar tour provides a transcript.
Sign-in is completed before the recording begins; credentials are never recorded.

```sh
bash scripts/setup.sh
npm exec --prefix frontend -- playwright install chromium
npm run docs:capture --prefix frontend
npm run build --prefix website
npm run docs:test --prefix frontend
```

The capture updates `docs/images/workspace.png`, `docs/images/lineage.png`, and
`docs/images/code.png`, plus `website/public/demos/northstar.webm` and its WebVTT
captions. The static build copies screenshots from `docs/images/`; do not edit
those generated copies in `website/public/demos/`. Commit the source screenshots
and video when changing a demonstrated workflow, so README and preview images
match the application. Keep fixtures synthetic and assertions meaningful.

Set `DUCKPAD_E2E_PORT` to isolate the recorder's backend port. The website tests
use `DUCKPAD_SITE_PORT` and `WEBSITE_BASE_PATH`, so both root and subpath hosting
can be checked. Browser executable and library overrides are shared with the
existing frontend test configuration.

## Automatic publishing

`.github/workflows/website.yml` runs on pull requests, pushes to `main`, completed
release workflows and manual dispatch. It builds the application, regenerates
the media from that revision,
checks and builds the site, and tests its links, search, mobile navigation,
reduced motion and video. A failed demonstration prevents publication. This
keeps the published screenshots and walkthrough tied to the code being shipped
without a bot committing generated media back to the repository.

To enable public hosting, a repository administrator selects **GitHub Actions**
under **Settings → Pages → Build and deployment**, and sets the repository Actions
variable **`PUBLISH_WEBSITE`** to **`true`**. The workflow uses GitHub's returned
origin and base path, so project Pages and a configured public custom domain use
the correct links. Only `main` can publish; pull requests upload a review artifact.
Until hosting is enabled, CI validates a `/duckpad/` subpath build and leaves
publication disabled. No private preview address is included in that artifact.

Publishing is static-only: GitHub Pages hosts the presentation and guides, not the
Python application. The quickstart explains how to run your own Duckpad instance.

## Changing a product workflow

1. Update the relevant guide and the recording selectors in
   `frontend/docs/capture.spec.ts` alongside the application change.
2. Run the capture, inspect the screenshots/video and commit the updated media.
3. Run the site checks and browser tests, including a subpath build when changing
   navigation or assets. CI repeats the recording before publishing from `main`.
