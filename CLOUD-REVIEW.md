# Cloud review 2026-11-05

Scope: `scheef-tech/layoutlens` at `main` = `b5a41fb`. Line numbers in **Findings** refer to `b5a41fb`.
All changes live on branch `cloud-review/2026-11-05`; `main` is untouched.

## TLDR

1. The capture service screenshotted any URL scheme: a job or a hostile sitemap could capture `file:///proc/self/environ` (holds `CLERK_SECRET_KEY`, `FIGMA_TOKEN`) and write files outside `RUNS_DIR` through the locale. Fixed in `7fa10f3` + `156b901`.
2. Opening a crafted gallery ZIP in the desktop app could write files anywhere in the user's home folder (Zip Slip, path to code execution). Fixed in `ceb312e`.
3. Jobs whose browser failed to start stayed `running` forever; the local run server exposed all screenshots to the LAN. Fixed in `4303065` + `88859f5`.
4. Hono/Clerk had known advisories (one affects the `cors()` default this service uses); bumped in range in `442a010`. Still open: SSRF towards internal hosts, `sharp` <0.35.
5. The repo had zero tests; now 20 microservice tests, 4 run-server tests and 3 Rust unit tests, all green.

## Findings

| Severity | Area | file:line | Issue | Fix |
|---|---|---|---|---|
| High | Security / capture | `services/figma-microservice/src/index.ts:101-110`, `src/capture.ts:242` | `POST /api/jobs` accepts any URL scheme. Verified: Chromium navigates `file:///…` and returns 200, so a job can screenshot `/proc/self/environ` with all server secrets. Sitemap `<loc>`/hreflang values flow into the `/dev` target list pre-selected, so a hostile site being scanned can plant these URLs. | Allow only `http:`/`https:` (**done, `7fa10f3`**). |
| High | Security / desktop | `src-tauri/src/main.rs:263` | `import_gallery` joins ZIP entry names onto the run dir (`out_dir.join(f.name())`). `../` or absolute entries write outside it (Zip Slip), e.g. into `~/Library/LaunchAgents`. Gallery ZIPs are meant to be shared. | Accept only normal path components (**done, `ceb312e`**). |
| High | Correctness / jobs | `services/figma-microservice/src/job-store.ts:50,102,194` | `void runJob()` without a catch: a `chromium.launch` or manifest write failure is an unhandled rejection and the job stays `running` forever; `/dev` and the plugin poll until timeout. | Catch, set `failed`, record reason (**done, `4303065`**). |
| Medium | Security / path traversal | `services/figma-microservice/src/capture.ts:253-259` | Locale goes unchecked into the artifact path; `../../x` writes screenshots outside `RUNS_DIR` (admin only). | Locale must match a BCP47-like token (**done, `7fa10f3`**). |
| Medium | Security / SSRF | `services/figma-microservice/src/sitemap.ts:55-65,207` | Bun `fetch()` reads `file://` (verified). Sitemap index entries were followed for any scheme, so a scanned site could make the service read local `*.xml` files. No fetch timeout. | http(s) only, 15 s timeout (**done, `156b901`**). |
| Medium | Security / SSRF | `src/sitemap.ts:55`, `src/capture.ts:242` | Both fetch and Playwright reach private, loopback and link-local hosts (e.g. `169.254.169.254`, other Coolify containers) incl. via redirects; sitemap content is attacker-controlled. | Resolve hosts and block private ranges in `fetch` and via `page.route()` (described, proposal 7). |
| Medium | Security / desktop | `scripts/serve-run.ts:226` | Run server listens on `0.0.0.0` with `Access-Control-Allow-Origin: *`: everyone on the LAN can read run screenshots and the manifest. | Bind `127.0.0.1` (**done, `88859f5`**). |
| Medium | Dependencies | `services/figma-microservice/bun.lock` (`hono@4.12.7`, `@clerk/backend@3.2.0`, `@clerk/shared@4.3.0`, `js-cookie@3.0.5`) | `bun audit`: 40 advisories incl. GHSA-88fw-hqm2-52qc (`cors()` default reflects Origin with credentials; `index.ts:20` uses that default) and Clerk authz bypasses (GHSA-w24r-5266-9c3c, GHSA-vqx2-fgx2-5wq9; the middleware path is unused here). | In-range bump (**done, `442a010`**, 3 left). |
| Medium | Dependencies | `services/figma-microservice/package.json` (`sharp@0.34.5`) | libvips/libheif/librsvg CVEs fixed in `sharp` 0.35.x. Input is only Chromium PNGs, so exposure is low. | Upgrade to `^0.35.5` after checking the 0.35 changelog (outside the `^0.34` range, so left as a description). |
| Medium | Correctness / desktop | `scripts/screenshot.ts:119-140,182-196` | One failing breakpoint rejects the whole run, so the manifest is never written and all finished shots are lost; `waitForImages` waits forever for an image that never fires load/error (lazy images). | try/catch per shot with `ok:false`, `Promise.race` timeout in `waitForImages`. |
| Medium | Correctness / artifacts | `services/figma-microservice/src/capture.ts:13-29,252` | `toRouteSlug` ignores the query string and folds `/a/b`, `/a-b`, `/A-B` into one slug: later captures silently overwrite earlier ones and two tasks point at one file. | Append a short hash of the full URL to the slug. |
| Low | Security / auth | `services/figma-microservice/src/index.ts:31,1241` | `DEV_DISABLE_AUTH=true` turns off every check (admin routes and unsigned job reads). A single flag in production opens the service. | Refuse to start with it when `NODE_ENV=production`, log a loud warning otherwise. |
| Low | Security / tokens | `services/figma-microservice/src/job-access.ts:10,14` | Signed job ids carry no expiry and the HMAC key falls back to `CLERK_SECRET_KEY` (key reuse across purposes). Effective lifetime = job TTL (24 h). | Require `JOB_ACCESS_SECRET`, add `exp` to the signed payload. |
| Low | Security / dev UI | `services/figma-microservice/src/index.ts:748,756` | `/dev` takes `AUTH` messages from any origin and has no `frame-ancestors`. An attacker can only inject a token of their own, so the impact is low. | Check `event.origin` against `CLERK_AUTHORIZED_PARTIES`, send `READY` to that origin, add CSP `frame-ancestors`. |
| Low | Security / DoS | `src/index.ts:61-62`, `src/selection.ts:295`, `src/sitemap.ts:64` | Client-chosen `maxUrls`/`maxSitemaps`, unbounded pages×locales×breakpoints and unbounded sitemap body size (admin only). | Server-side caps (e.g. 2 000 tasks, 5 MB per sitemap). |
| Low | Security / desktop | `src-tauri/capabilities/default.json:8-9` | `shell:allow-execute` and `shell:allow-spawn` are granted to both windows, while the frontend never imports `@tauri-apps/plugin-shell`. | Remove both permissions to shrink the blast radius of any webview XSS. |
| Low | Security / plugin | `plugins/layoutlens-importer/src/main.ts:272` | Stored base URL is interpolated into the plugin UI HTML without escaping (self-XSS). | HTML-escape or set the value via `postMessage`. |
| Low | Supply chain / CI | `.github/workflows/heatmap.yml:19,22,25` | Actions pinned by tag, `bun install` runs dependency lifecycle scripts with `ST_REGISTRY_TOKEN` in env and a `contents: write` checkout token. | Pin actions by SHA, `bun install --ignore-scripts`, separate token for checkout (CI left untouched by this review). |
| Low | Dependencies (dev) | root `bun.lock` | `bun audit`: 110 advisories, mostly dev tooling (`vite@5.4.19`, `tar` via `@tailwindcss/oxide`, `esbuild`). The shipped app is a static build. | `bun audit fix` in range, then plan vite 6+. |
| Low | Correctness / jobs | `services/figma-microservice/src/job-store.ts:216-233` | TTL cleanup deletes the run dir of a job that is still running (job older than TTL). | Skip jobs with status `queued`/`running`. |
| Low | Correctness / jobs | `services/figma-microservice/src/job-store.ts:193-194` | Status flips to `success` before `manifest.json` is written. | Write the manifest first, then set the status. |
| Low | Correctness / desktop | `src-tauri/src/main.rs:65,258` | Run and import ids have one-second resolution; two runs in the same second share a directory. | Use millis plus a random suffix. |
| Low | Correctness / desktop | `src-tauri/src/main.rs:349` | Every `open_figma_importer` spawns a new run server on port 7777 and never stops the old one; the second spawn dies on `EADDRINUSE` silently (stdout/stderr are discarded) and the old run keeps being served. | Keep the child handle, kill it before respawning. |
| Low | Correctness / dev UI | `services/figma-microservice/src/index.ts:979` | Polling gives up after 240 × 2.5 s = 10 min without a message; big jobs look stuck. | Show a timeout state and a "resume polling" button. |
| Low | Correctness / API | `services/figma-microservice/src/index.ts:281` | `sliceTop` beyond the image height is clamped to the last row and returns a 1 px slice. | Return 416/400 for `sliceTop >= height`. |
| Low | Correctness / API | `services/figma-microservice/src/sitemap.ts:207-214` | An already visited sitemap URL was reported as a page. | Skip it (**done, `156b901`**). |
| Low | Deploy | `services/figma-microservice/Dockerfile:1` | Base image Playwright 1.55.0, lockfile resolves 1.58.2, so browsers are downloaded again at build time. | Align the image tag with the lockfile (deploy config left untouched). |
| Info | Secrets | git history | Checked all commits for `.env` files and common token prefixes: none found. Logger prints URLs and ids only, no tokens. | – |

## Proposals

1. **Restrict capture input to http(s) URLs, safe locales and integer breakpoints** (closes the `file://` secret leak and the RUNS_DIR traversal). `implemented in 7fa10f3`
2. **Zip Slip guard for gallery imports** (`src-tauri/src/zip_safety.rs`). `implemented in ceb312e`
3. **Mark crashed jobs as failed** so pollers reach a terminal state. `implemented in 4303065`
4. **Harden sitemap discovery**: http(s) only, malformed entries skipped, fetch timeout, 400 for bad `baseUrl`. `implemented in 156b901`
5. **Run server on loopback only** plus 400 for malformed `abs`. `implemented in 88859f5`
6. **In-range bump of hono and @clerk/backend** (37 of 40 audit advisories gone). `implemented in 442a010`
7. **Egress guard and job limits for the microservice** – `described only`. New `src/net-guard.ts` that resolves the host (DNS) and blocks loopback, RFC1918, link-local, CGNAT and IPv6 ULA ranges; use it in `sitemap.ts` (with `redirect: "manual"` and re-checking each hop) and in `capture.ts` through `context.route("**/*", …)` so redirects and subresources are covered too. In `index.ts`/`selection.ts`, cap `maxUrls`, `maxSitemaps`, total tasks and sitemap body size. Larger because it needs an allowlist decision for staging hosts that live on private networks.

Further candidates, smaller in value: robust per-shot error handling in `scripts/screenshot.ts`; unique artifact slugs in `capture.ts`; `sharp` 0.35 upgrade; `/dev` origin check + CSP; dropping the unused shell permissions in `src-tauri/capabilities/default.json`.

## Tests

**Before:** the repository had no tests. `bun test` in `services/figma-microservice` → `0 test files matching …`, exit 1. `bunx tsc --noEmit` → exit 0.

**After (branch head):**
- `services/figma-microservice`: `bun run test` (= `bun test --isolate`) → **20 pass, 0 fail** across `validation`, `jobs-api`, `job-store`, `sitemap`, `auth`. Playwright and Clerk are replaced by mocks or offline paths; the route tests run against `app.fetch` with `DEV_DISABLE_AUTH=true`.
- root: `bun test scripts` → **4 pass, 0 fail** (spawns `scripts/serve-run.ts`, also checks it is unreachable on the container's LAN IPv4).
- `rustc --edition 2021 --test src-tauri/src/zip_safety.rs` → **3 passed**.
- `bunx tsc --noEmit` (microservice) → exit 0.
- Each fix commit's new tests were run with the fix stashed and failed as expected (API validation 4 fail, job-store 1 fail, sitemap/discover 5 fail, serve-run 2 fail).

**The 5 most valuable missing tests**
1. `GET /api/jobs/:jobId/artifacts/*` authz: signed token for job A against job B, unsigned id without admin, `..` and encoded `%2e%2e` segments – this route is the main access boundary towards Figma.
2. `job-access.ts`: tampered signature, missing secret, bare id falls back to admin – protects the signed-link scheme from regressions.
3. `capture.ts` artifact naming: different URLs must never map to the same file (the slug collision above).
4. `scripts/screenshot.ts` against a local fixture server: one failing breakpoint keeps the other shots and the manifest; a never-loading image ends via timeout.
5. `job-store` cleanup sweep: expired jobs and orphan dirs are removed, running jobs stay.

## Verified

Commands run in this session (results abbreviated):

```text
git fetch origin main                                   -> main = b5a41fb (= starting branch)
git checkout -b cloud-review/2026-11-05 origin/main     -> ok
git log --since=60.days --name-only                     -> only assets/commit-heatmap.svg changed (bot); last code change: 140fde9 README
git log --all ... -- '*.env' / token-prefix grep        -> no committed env files or tokens
bun --version / cargo --version                         -> 1.4.4 / 1.97.0
cd services/figma-microservice && bun install --frozen-lockfile --ignore-scripts -> 27 packages
bun test (before changes)                               -> "0 test files", exit 1
bunx tsc --noEmit (before)                              -> exit 0
bun audit (root)                                        -> 110 vulnerabilities (1 critical, 44 high, 53 moderate, 12 low)
bun audit (microservice, before)                        -> 40 vulnerabilities (1 critical, 8 high, 29 moderate, 2 low)
bun -e 'fetch("file://…/probe.xml")'                    -> 200: Bun fetch reads local files
node pwprobe.cjs (Playwright goto file:///etc/hostname) -> "file:// navigation ok, status 200"
bun test --isolate (per fix, with fix stashed)          -> new tests fail as expected
bun update hono @clerk/backend --ignore-scripts         -> hono 4.13.16, @clerk/backend 3.26.6
bun audit (microservice, after)                         -> 3 vulnerabilities (3 high, all sharp <0.35)
rm -rf node_modules && bun install --frozen-lockfile --ignore-scripts -> ok (lockfile consistent)
bun run test (microservice, head)                       -> 20 pass, 0 fail
bunx tsc --noEmit (microservice, head)                  -> exit 0
bun test scripts (root, head)                           -> 4 pass, 0 fail
rustc --edition 2021 --test src-tauri/src/zip_safety.rs -> 3 passed
rustfmt --edition 2021 --check src-tauri/src/main.rs    -> parses (formatting diff only, pre-existing style)
cargo check (src-tauri)                                 -> fails: gdk-3.0.pc / WebKitGTK system libs missing
bun install (root)                                      -> 401 from npm.pkg.github.com for @scheef-tech/utility-belt (needs ST_REGISTRY_TOKEN)
```

## Not checked

- **SvelteKit frontend build / svelte-check**: root `bun install` needs `ST_REGISTRY_TOKEN` for the private `@scheef-tech/utility-belt` package (401); no credentials were looked for. Frontend code was reviewed by reading only (no `{@html}` or `innerHTML` sinks found outside shadcn components).
- **Full Rust build**: `cargo check` needs GTK/WebKitGTK dev libraries. The Zip Slip helper was compiled and tested standalone; its call site in `main.rs` was parse-checked with rustfmt and reviewed by hand.
- **Figma plugin build** (`plugins/layoutlens-importer`): dependencies not installed; reviewed by reading.
- **Real Clerk tokens / JWKS, Figma API, Docker image build, Coolify deployment**: need external accounts or services; auth was tested only offline (malformed and missing tokens).
- **End-to-end capture of real websites**: only the `file://` navigation probe ran with the pre-installed Chromium; capture is mocked in tests.
- **CI and deploy files** (`.github/workflows/heatmap.yml`, `Dockerfile`): reviewed, intentionally left unchanged.
- **Windows-specific path handling** in `serve-run.ts` and the artifact route: the app targets macOS and the service runs on Linux.
- **`sharp` 0.35 compatibility**: upgrade crosses the declared range, left for a separate change.
