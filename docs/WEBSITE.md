# Website and documentation

The site in `website/` uses Astro to build static HTML from the guides in `docs/`.
Navigation works without JavaScript; search, theme selection and code copying use
small browser scripts. Fonts are self-hosted and videos load on request.

## Work on the site

Use **Node.js 22.23.4+**. From the repository root:

```sh
npm ci --prefix website
npm run dev --prefix website
```

Edit the Markdown in `docs/`. Register a new public guide in both
`website/src/content.config.ts` and `website/src/lib/docs.ts`. The build rewrites
relative guide links and copies `docs/images/` into the site's media directory.
For repository-only documents, use `../docs/<FILE>.md` so the site links to GitHub
instead of generating a nonexistent documentation route.

```sh
npm run check --prefix website
npm run build --prefix website
npm run preview --prefix website
```

`WEBSITE_BASE_PATH` sets the deployment prefix (default `/`). `SITE_ORIGIN` sets
an optional public canonical origin; leave it unset for private previews.
Output goes to `website/dist/`. The application image serves a separate build
under `/site/`.

## Release notes

`/releases/` and `/releases.json` are built from published GitHub releases.
The build uses `GITHUB_TOKEN` when supplied; authenticated API failures fail it.
Without a token, an API failure falls back to `website/src/data/releases.json`.
Refresh that snapshot with:

```sh
npm run releases:update --prefix website
```

Keep tokens in the build environment. The browser receives static content only.
The GitHub star count is also read at build time; if unavailable, the header keeps
a working Star link without a count.

## Regenerate the demonstrations

The homepage film is an edited production at
`website/public/demos/duckpad-overview.mp4`, with WebVTT captions and the poster
`docs/images/duckpad-overview.jpg`. Its source project is maintained separately.
For a film update, replace and review the video, captions and poster together.
The automated recorder below updates the Northstar tutorial, not that film.

```sh
bash scripts/setup.sh
npm exec --prefix frontend -- playwright install chromium
npm run docs:capture --prefix frontend
npm run build --prefix website
npm run docs:test --prefix frontend
```

`docs:capture` runs `frontend/docs/capture.spec.ts` for the Northstar video and
`screenshots.spec.ts` for guide images. To update only screenshots:

```sh
npm run docs:screenshots --prefix frontend
```

Captures use a disposable authenticated instance and synthetic fixtures. The
suite verifies runs and lineage before capturing. Keep English, light theme,
UTC and the fixed viewport for consistent images. Sign-in happens before recording;
never include credentials or private infrastructure in media.

The recorder writes `website/public/demos/northstar.webm` and its captions.
Screenshots belong in `docs/images/`; do not edit generated copies under
`website/public/demos/`.

Set `DUCKPAD_E2E_PORT` for the capture backend and `DUCKPAD_SITE_PORT` for website
tests. Test subpath hosting with matching `WEBSITE_BASE_PATH` values at build and
test time. Browser executable and library overrides follow the frontend's
Playwright configuration.

## Automatic publishing

`.github/workflows/website.yml` runs on pull requests, `main` pushes, completed
release workflows and manual dispatch. It builds the app, regenerates tutorial
media and screenshots, builds the site, and checks links, search, mobile
navigation, accessibility and video. Pull requests upload a review artifact.

To publish, select **GitHub Actions** under **Settings → Pages → Build and
deployment** and set the Actions variable **`PUBLISH_WEBSITE=true`**. Only `main`
publishes. The workflow uses the Pages origin and base path; without publishing
enabled, it validates a `/duckpad/` build. Pages hosts the guides and presentation,
not the Python application.

The workflow rebuilds after **Release Duckpad** completes. After manually editing
or deleting release notes, run it with `workflow_dispatch`.

## Changing a product workflow

1. Update its guide and the relevant selectors in the capture or screenshot suite.
2. Run the capture, inspect the output and commit the updated media.
3. Run the website checks and browser tests. Test a subpath build when changing
  navigation or assets.
