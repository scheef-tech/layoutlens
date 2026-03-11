# LayoutLens Figma Microservice

Hono-based backend service for "Website -> Figma" workflow:

- discovers pages from `sitemap.xml` / sitemap indexes
- lets you select pages, locales, and breakpoints
- captures screenshots for each page x locale x breakpoint
- runs import jobs for each locale x breakpoint x page selection

## Run

From repo root:

```bash
bun run microservice:dev
```

Or directly:

```bash
cd services/figma-microservice
bun run dev
```

Service defaults to `http://localhost:8787`.

## Dev UI

Open:

- `http://localhost:8787/dev`

The dev UI can:

- discover sitemap URLs
- select pages
- set locales + breakpoints
- create a job and poll status

`/dev` is a lightweight shell UI. API actions from that UI require a Clerk Bearer token
(admin role required). The easiest way to use it is embedding `/dev` inside `client-portal`,
which already posts Clerk tokens to embedded modules.

Artifact reads are secured with a signed job identifier:

- Dev UI surfaces a **signed job id** (`<uuid>.<signature>`).
- The Figma plugin must use that signed id for `/api/jobs/:jobId` and artifact URLs.

## API

- `GET /health`
- `POST /api/sitemap/discover` (Clerk admin)
- `POST /api/jobs` (Clerk admin)
- `GET /api/figma/projects?teamId=<id>` (Clerk admin)
- `GET /api/figma/projects/:projectId/files` (Clerk admin)
- `GET /api/jobs` (Clerk admin)
- `GET /api/jobs/:jobId` (`:jobId` can be signed job id; unsigned requires Clerk admin)
- `GET /api/jobs/:jobId/artifacts` (`:jobId` can be signed job id; unsigned requires Clerk admin)
- `GET /api/jobs/:jobId/artifacts/<relative-file-path>` (same signed access rules)

## Figma token

`FIGMA_TOKEN` is only needed for listing team/project/file data in the Dev UI:

```bash
FIGMA_TOKEN=... bun run dev
```

Capture jobs are now capture-only; the plugin imports artifacts into canvas.

Environment flags:

- `FIGMA_TEAM_ID=...` (for dev UI project/file picker default)
- `CLERK_SECRET_KEY=...` (required for Clerk verification)
- `CLERK_AUTHORIZED_PARTIES=https://app.scheef.tech,http://localhost:5173` (comma-separated)
- `JOB_ACCESS_SECRET=...` (optional; defaults to `CLERK_SECRET_KEY`)
- `JOB_CONCURRENCY=3`
- `FIGMA_API_TIMEOUT_MS=30000`
- `PLAYWRIGHT_LAUNCH_TIMEOUT_MS=30000`
- `CAPTURE_NAV_TIMEOUT_MS=90000`

Note on creating projects/files:

- Public Figma REST currently supports listing teams/projects/files but not creating project/file entities.
- `/dev` includes buttons to open the correct Figma web pages (team/project) so you can create there and reload selectors.

If `FIGMA_TOKEN` is missing, only Figma project/file listing endpoints are unavailable.

## Capture behavior

- Uses Playwright Chromium in headless mode.
- Reuses one browser per job and runs task workers concurrently.
- Stores screenshots under `runs/<jobId>/<locale>/<route>/<breakpoint>.png`.
- Writes a `manifest.json` to `runs/<jobId>/manifest.json`.
- Sends `Accept-Language` by default (`sendAcceptLanguage` can disable this in job payload).
- Supports locale cookie injection via `localeCookie` in job payload, or env fallback `LOCALE_COOKIE_NAME`.
- No Figma write calls are executed during jobs.

## Locale discovery behavior

- `discoveredLocales` is now built from sitemap `xhtml:link hreflang` values first.
- URL-prefix locales (like `/en/...`) are still detected as a fallback.
- Optional env `SITEMAP_DEFAULT_LOCALE` adds your default locale when routes are unprefixed.

## Docker (Coolify-friendly)

This service includes `Dockerfile` and `.dockerignore`.

Build and run locally:

```bash
docker build -t layoutlens-figma-microservice .
docker run --rm -p 8787:8787 \
  -e PORT=8787 \
  -e CLERK_SECRET_KEY=your_clerk_secret \
  -e CLERK_AUTHORIZED_PARTIES=https://app.scheef.tech,http://localhost:5173 \
  -e PLAYWRIGHT_CHROMIUM_ARGS="--no-sandbox --disable-setuid-sandbox" \
  -e FIGMA_TOKEN=your_token_here \
  layoutlens-figma-microservice
```

Optional runtime mode:

- `RUN_MODE=dev` -> starts with `bun --hot`
- default -> starts with `bun src/index.ts`

### Coolify notes

- Set **Port** to `8787` (or set your `PORT` env to whatever Coolify maps).
- Set `CLERK_SECRET_KEY` in Coolify env vars.
- Optionally set `JOB_ACCESS_SECRET` if you want signature separation from Clerk secret.
- Set `PLAYWRIGHT_CHROMIUM_ARGS=--no-sandbox --disable-setuid-sandbox` if your Coolify runtime requires it.
- Set `FIGMA_TOKEN` only if you want Figma team/project/file listing in `/dev`.
