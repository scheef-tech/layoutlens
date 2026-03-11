# LayoutLens -> Figma Automation Plan

This plan tracks the migration to a backend-driven + plugin-import workflow.

## Goal

Import all captured screenshots into Figma pages/frames reliably, then automate the plugin execution flow.

## Current status

- Microservice captures sitemap routes x locales x breakpoints.
- `/dev` can create jobs, monitor progress, and provides post-job actions.
- Figma plugin (`plugins/layoutlens-importer`) now imports by `jobId` from microservice APIs.

## Phase 1 - Stabilize manual import (do this first)

- [x] Show job id + next steps in `/dev` after job completion.
- [x] Add "Open file in Figma" helper button in `/dev`.
- [x] Connect plugin importer to `/api/jobs` and artifact endpoints.
- [ ] Add plugin UI defaults: prefill base URL and last used job id.
- [ ] Add idempotent import mode in plugin (update existing route/locale sections instead of duplicating).
- [ ] Add plugin-side error panel (failed artifacts list with reasons).

## Phase 2 - Semi-automation (trigger plugin flow faster)

- [ ] Add `/dev` button: "Copy plugin launch instructions" (base URL + job ID).
- [ ] Add optional callback endpoint for plugin import completion (`POST /api/jobs/:id/plugin-import-status`).
- [ ] Show "captured", "plugin imported", "figma finalized" statuses in `/dev`.

## Phase 3 - Full automation exploration

- [ ] Evaluate desktop/browser orchestration to open Figma + run plugin with prefilled payload.
- [ ] Add secure handoff token so plugin can fetch only the intended job.
- [ ] Add resilient retry pipeline for large imports and resume from last imported group.

## Phase 4 - Project/folder creation workflows

- [ ] Track official Figma API capabilities for project/file creation endpoints.
- [ ] If unavailable, keep web-open helpers and add guided creation wizard in `/dev`.
- [ ] If endpoints become available, replace guided steps with true create actions.

## Immediate next actions

1. Reinstall/update plugin build in Figma.
2. Run a medium-size job in `/dev` and import via plugin using shown job id.
3. Confirm section naming and layout structure in Figma.
4. Implement idempotent plugin import mode next.
