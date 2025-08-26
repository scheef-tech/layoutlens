Title: LayoutLens Codex (000 - Always Included)

Purpose: Non-negotiable rules I follow to build and maintain LayoutLens.

- Core stack: SvelteKit + Tauri v2 + Bun + Playwright. UI uses shadcn-svelte with Tailwind.
- Svelte: v5+ runes only. Do not use `svelte/store`. Prefer `$state`, `$derived`, `$effect` in components.
- Persist progress in `progress/` with small, dated checkpoints. No fluff, no repetition.
- Continuously consult `plan.md` and keep implementation aligned with Acceptance Criteria.
- Multi-locale via cookie: set cookie before navigation per locale; optional `Accept-Language`; optional URL templating.
- Screenshot grid: capture full-page screenshots for all locale × breakpoint pairs. Save under `runs/<id>/<locale>/<bp>.png` and write `manifest.json`.
- Two windows: main (form + capture), gallery (canvas + filters + export). Open gallery after capture, emit `"shots:loaded"` with `RunManifest`.
- Security/capabilities: allow only the minimum (shell, fs). Spawn Bun sidecar for Playwright through Tauri shell plugin.
- Use types across Rust/TS mirroring `RunManifest` and `Shot`.
- Non-interactive automation: prefer Bun scripts and deterministic commands. No manual steps.
- Docs: Always consult Context7 MCP for documentation; prefer it for setup, coding, and maintenance. When in doubt, read official docs (Tauri v2, SvelteKit, Bun, Playwright, shadcn-svelte) and encode decisions into the repo.

Runtimes & reactivity:

- State management lives in components via runes. If cross-route sync is needed, use window events or Tauri events and set component `$state` accordingly, not global stores.

Acceptance checklist (Phase 1):

- Input URL, breakpoints, locales, cookie config and behavior.
- Capture full-page screenshots for every locale × breakpoint using cookie mechanism.
- Auto-open gallery window; pan/zoom/drag canvas; filter by locale/breakpoint.
- AI analysis is scaffold-only, not implemented yet.

Contributor guidance:

- Keep edits small and cohesive. Update `progress/` after each meaningful step.
- Don’t repeat explanations; link to files and keep deltas clear.
- Prefer explicit configuration and typed APIs. Minimize globals.
