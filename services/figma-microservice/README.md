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

You can protect `/dev` with Basic Auth by setting:

```bash
DEV_UI_BASIC_AUTH=admin:change-me
```

If `DEV_UI_BASIC_AUTH` is empty, `/dev` is public.

## API

- `GET /health`
- `POST /api/sitemap/discover`
- `POST /api/jobs`
- `GET /api/jobs`
- `GET /api/jobs/:jobId`
- `GET /api/jobs/:jobId/artifacts`
- `GET /api/jobs/:jobId/artifacts/<relative-file-path>`

## Figma token

Set `FIGMA_TOKEN` to enable Figma write integration:

```bash
FIGMA_TOKEN=... bun run dev
```

Current write mode uses the Figma REST `dev_resources` endpoint:

- each captured artifact URL is linked as a Dev Resource on a target node
- set target node via request `figmaNodeId` or env `FIGMA_TARGET_NODE_ID`
- service needs a public base URL to build artifact links (`artifactPublicBaseUrl` or `ARTIFACT_PUBLIC_BASE_URL`)

Environment flags:

- `FIGMA_WRITE_MODE=dev_resources` (default)
- `FIGMA_TARGET_NODE_ID=1:2`
- `ARTIFACT_PUBLIC_BASE_URL=https://your-service.example.com`

If `FIGMA_TOKEN` is missing, the service captures screenshots but skips Figma writes.

## Capture behavior

- Uses Playwright Chromium in headless mode.
- Stores screenshots under `runs/<jobId>/<locale>/<route>/<breakpoint>.png`.
- Writes a `manifest.json` to `runs/<jobId>/manifest.json`.
- Sends `Accept-Language` by default (`sendAcceptLanguage` can disable this in job payload).
- Supports locale cookie injection via `localeCookie` in job payload, or env fallback `LOCALE_COOKIE_NAME`.

## Docker (Coolify-friendly)

This service includes `Dockerfile` and `.dockerignore`.

Build and run locally:

```bash
docker build -t layoutlens-figma-microservice .
docker run --rm -p 8787:8787 \
  -e PORT=8787 \
  -e DEV_UI_BASIC_AUTH=admin:change-me \
  -e PLAYWRIGHT_CHROMIUM_ARGS="--no-sandbox --disable-setuid-sandbox" \
  -e FIGMA_WRITE_MODE=dev_resources \
  -e FIGMA_TARGET_NODE_ID=1:2 \
  -e ARTIFACT_PUBLIC_BASE_URL=https://your-service.example.com \
  -e FIGMA_TOKEN=your_token_here \
  layoutlens-figma-microservice
```

Optional runtime mode:

- `RUN_MODE=dev` -> starts with `bun --hot`
- default -> starts with `bun src/index.ts`

### Coolify notes

- Set **Port** to `8787` (or set your `PORT` env to whatever Coolify maps).
- Set `DEV_UI_BASIC_AUTH` in Coolify env vars to protect `/dev`.
- Set `PLAYWRIGHT_CHROMIUM_ARGS=--no-sandbox --disable-setuid-sandbox` if your Coolify runtime requires it.
- Set `FIGMA_TOKEN` for Figma writes.
- Set `FIGMA_TARGET_NODE_ID` to the node where Dev Resource links should be attached.
- Set `ARTIFACT_PUBLIC_BASE_URL` to your deployed service URL so Figma links are reachable.
