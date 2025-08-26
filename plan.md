---

# Cursor Task Prompt — “LayoutLens” (with Locales via Cookie)

## Goal

Build a **macOS native** desktop app using **Tauri v2 + SvelteKit + Bun** that:

1. Lets me input:

   * **Website URL** (supports `http://localhost:xxxx`)
   * **Breakpoints array**
   * **Locales array** (e.g., `["en", "de", "fr"]`)
   * **Locale cookie config** (cookie name + optional domain/path + SameSite/secure flags)
2. Captures **full-page screenshots** for **each locale × breakpoint**.
3. Opens a **second window** that displays **all screenshots on a movable/zoomable canvas**; I can pan/zoom and drag images around; filter by locale/breakpoint.
4. (Phase 2, later) Integrate **Chat GPT-5 (vision)** to review screenshots for layout issues (overlaps, spacing, contrast, tap targets, hierarchy).

> Important details to **preserve** (from the original spec):
>
> * Tech stack: **SvelteKit + Tauri v2 + Bun** (mac native).
> * Inputs: **Website URL**, **breakpoints array** (e.g., `[320,375,414,768,1024,1280,1440]`).
> * Screenshot engine via **Playwright** (Bun sidecar).
> * After capture, open **another window** with a **canvas** to arrange/inspect all screenshots.
> * Future: **Chat GPT-5** layout/UX analysis.
> * **New**: **Locales** support via **cookie mechanism** (work with **ParaglideJS**). Keep URL/localhost support.

---

## Locale Mechanism (Cookie-based; ParaglideJS-friendly)

- Add form fields:

  - **Locales**: array of locale codes (e.g., `["en", "de", "fr"]`).
  - **Locale Cookie Name**: string (default something generic like `"locale"`; must be editable to match ParaglideJS).
  - **Cookie Domain** (optional): default derived from the URL host (for localhost, use `localhost`).
  - **Cookie Path** (optional): default `"/"`.
  - **Cookie Flags**: `secure` (default `false` for localhost), `httpOnly` (default `false`), `sameSite` (default `"Lax"`).
  - **(Optional) Accept-Language header toggle**: if enabled, also send `Accept-Language: <locale>` per navigation—nice fallback if the site uses header detection.
  - **(Optional) URL locale templating**: bool + template, e.g., `/{locale}{pathname}` or query `?lang={locale}` (kept off by default since we’re using cookies; expose for flexibility).

- For each **locale**:

  - Create a **fresh Playwright browser context**.
  - **Pre-set the locale cookie** in the context **before** navigating:

    - `name: <cookieName>`
    - `value: <locale>`
    - `domain: <derived or provided>`
    - `path: <path>`
    - `sameSite`, `secure`, `httpOnly` per form.

  - Optionally set `extraHTTPHeaders['Accept-Language'] = locale` if the toggle is on.
  - Navigate to the (possibly templated) URL and capture screenshots at all breakpoints.

---

## High-Level Architecture (unchanged + locale additions)

- **Frontend (SvelteKit)**

  - **Main window**: form with URL, breakpoints, **locales**, cookie config, “Capture” button, status/progress per locale×breakpoint.
  - **Gallery window**: canvas view showing all screenshots; **filters** for locale and breakpoint; simple export.

- **Backend (Tauri v2 + Rust)**

  - Commands:

    - `run_screenshot_job(url: String, breakpoints: Vec<u32>, locales: Vec<String>, cookie: CookieConfig, behavior: BehaviorFlags) -> Result<RunManifest, String>`
    - `open_gallery(manifest: RunManifest) -> Result<(), String>`

  - Spawns a **Bun** sidecar that runs the **Playwright** script with full args (URL, breakpoints, locales, cookie options).

- **Screenshot engine (Bun + Playwright)**

  - For each locale:

    - New **context** with cookie/header pre-set.
    - For each breakpoint:

      - Full-page screenshot.

  - Saves to `runs/<timestamp>/<locale>/<width>.png` with a `manifest.json`.

---

## Data Structures

**Rust / TS common types (extend previous):**

```ts
export type Shot = {
  locale: string; // NEW
  breakpoint: number;
  path: string; // absolute
  width: number;
  height: number;
  ok: boolean;
  error?: string;
};

export type RunManifest = {
  id: string; // timestamp/uuid
  url: string;
  breakpoints: number[];
  locales: string[]; // NEW
  cookie: {
    name: string;
    domain?: string;
    path?: string;
    sameSite?: "Lax" | "Strict" | "None";
    secure?: boolean;
    httpOnly?: boolean;
  };
  behavior: {
    sendAcceptLanguage?: boolean;
    urlTemplate?: string | null; // e.g. "/{locale}{pathname}" or "?lang={locale}"
    useUrlTemplate?: boolean;
  };
  out_dir: string;
  shots: Shot[];
};
```

---

## Project Structure (key files unchanged; add locale UI)

```
layoutlens/
  scripts/
    screenshot.ts           // Bun + Playwright — now handles locales + cookies
  src/
    routes/+page.svelte     // form now includes locales + cookie config
    gallery/+page.svelte    // gallery with locale/breakpoint filters
    lib/components/CanvasBoard.svelte
    lib/components/Filters.svelte  // NEW: simple controls for locale/bp
    lib/stores/job.ts
    lib/types.ts
    lib/utils/path.ts
  src-tauri/
    tauri.conf.json
    src/main.rs
```

---

## Tauri v2 Config

Same as before (two windows; allowlist shell/fs/path/event). Keep dev URL and build config. No change required for locales.

---

## Rust (Tauri v2) — `src-tauri/src/main.rs`

- Extend `run_screenshot_job` args to accept `locales`, `cookie`, `behavior`.
- Spawn sidecar with serialized JSON config (write to a temp file or pass as CLI arg) to avoid shell escaping issues.
- After script completes, read `manifest.json`, emit `"shots:loaded"` to **gallery** window, and make it visible.

---

## Bun + Playwright — `scripts/screenshot.ts` (Pseudo-flow)

1. Parse JSON config (`url`, `breakpoints`, `locales`, `cookie`, `behavior`, `outDir`).
2. For each `locale`:

   - `const context = await browser.newContext({ extraHTTPHeaders: behavior.sendAcceptLanguage ? { 'Accept-Language': locale } : undefined });`
   - **Set cookie** via `context.addCookies([{ name, value: locale, domain, path, sameSite, secure, httpOnly }])`.
   - Build the **navigation URL**:

     - If `behavior.useUrlTemplate`, apply template: replace `{locale}` and `{pathname}`.
     - Else use the base URL unchanged (cookie alone should switch locale in ParaglideJS).

   - `const page = await context.newPage();`
   - For each `breakpoint`:

     - `page.setViewportSize({ width: bp, height: 1000 });`
     - `await page.goto(navUrl, { waitUntil: 'networkidle', timeout: 60000 });`
     - Optional wait hook (e.g., `await page.waitForTimeout(500);`) to let CSS settle.
     - `await page.screenshot({ path: <out>/<locale>/<bp>.png, fullPage: true });`
     - Record to manifest with measured document size if desired.

   - `await context.close();`

3. Write `manifest.json` with all shots.

**Notes/Edge cases:**

- **localhost cookies**: use `domain: "localhost"` and `secure: false`.
- If the site sets/overwrites the cookie on first load, consider navigating to a **neutral route** first, set cookie, and **reload**.
- Some apps rely on hydration; consider a small post-load wait or a selector wait to ensure locale content is visible.
- If using `sameSite: "None"`, you must set `secure: true` (not recommended on localhost); default `"Lax"` is fine.

---

## SvelteKit — Main Window (`src/routes/+page.svelte`)

Form fields:

- **URL**
- **Breakpoints** (chips/comma input)
- **Locales** (chips/comma input)
- **Cookie**:

  - Name (text)
  - Domain (optional)
  - Path (default `/`)
  - SameSite (select: Lax/Strict/None)
  - Secure (checkbox)
  - HttpOnly (checkbox)

- **Behavior**:

  - Send `Accept-Language` header (checkbox)
  - Use URL template (checkbox)
  - URL template (text, with placeholders `{locale}` and `{pathname}`)

    - Example: `/{locale}{pathname}` or `?lang={locale}`

- **Capture** button → `invoke('run_screenshot_job', { ... })`.

---

## Gallery Window (`src/routes/gallery/+page.svelte`)

- Listen for `"shots:loaded"` with `RunManifest`.
- **Filters**: dropdowns for **Locale** and **Breakpoint**; quick “All” options.
- **CanvasBoard**:

  - Pan/zoom, drag to reposition screenshots.
  - Group by locale (e.g., rows per locale) or free placement.
  - HUD shows run id, URL, cookie name, selected locale/bp.
  - Export layout JSON to the run folder.

---

## Dev & Run

- Dev:

  - `bun dev` (SvelteKit)
  - `bun x tauri dev`

- Localhost testing:

  - Ensure cookie works on `http://localhost:xxxx`.
  - Try multiple locales and breakpoints simultaneously.

- Artifacts:

  - `runs/<timestamp>/<locale>/<bp>.png`
  - `runs/<timestamp>/manifest.json`

---

## Acceptance Criteria (Phase 1 with Locales)

- I can enter **URL**, **breakpoints**, **locales**, and **cookie** settings.
- The app captures **full-page screenshots for every locale × breakpoint** using the **cookie mechanism** (compatible with ParaglideJS).
- A **second window** opens showing a **canvas** with all screenshots; I can pan/zoom/drag, and **filter by locale/breakpoint**.
- No AI yet.

---

## Phase 2 (Plan Only)

- “Analyze with **GPT-5 (vision)**” button in the gallery:

  - Send selected screenshots + rubric (overlap, spacing, grids, contrast/legibility, tap targets, hierarchy).
  - Display issues per screenshot/locale with annotations or a side panel.

---

## Nice-to-haves (optional)

- Persist last URL, breakpoints, locales, cookie config.
- Parallelize captures per locale to speed up runs (limit concurrency).
- Toggle browser engine (Chromium/WebKit).
- Thumbnail strip by locale.
- Diff mode (compare locales side-by-side at the same breakpoint).

---

**Please generate the full implementation** (files + code) with the **locale + cookie** feature exactly as specified, keeping the original goals intact. Adapt to **Tauri v2** APIs as needed. The first milestone remains: multi-locale, multi-breakpoint screenshots and the interactive canvas gallery. The **AI step (GPT-5)** is just scaffolded for later.
