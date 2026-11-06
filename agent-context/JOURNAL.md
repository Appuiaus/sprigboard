# Journal

Curated, newest first: what each session did and why, with gotchas for the next session.

## 2026-11-06: v1 (cloud session)

- **What:** the first full version, built from Pedro's call with Jamie: jobs, plan upload, plan
  reading by Claude, checklist, plant library matching, title block export for Illustrator, size-tier
  prices, invoices. Stack and Access check copied from BidSidekick (`src/access.ts` is the same file).
- **Decisions:**
  - The Claude API is called directly from the Worker, not through the VelosoLabs gateway. The
    gateway's `claude.complete` is text-only, and plan reading needs PDF and image input.
  - The model drafts and Jamie decides. Claude items are a checklist she ticks off. A re-read replaces
    only the unticked Claude items from that file. It fills blank job fields but never overwrites them.
  - Title block export uses Illustrator variables (text only). The logo stays in her template, because
    image variables need local file paths.
  - Invoice numbers are taken atomically (`UPDATE … RETURNING`) and never reused, even after a delete.
    "Carry on from your last invoice" seeds the series from her paper invoices.
  - Records are soft-deleted (`deleted_at`).
- **Gotchas:**
  - `wrangler dev` rewrites the request host to the custom domain. Run it with
    `--local-upstream localhost` so the localhost-only `DEV_ACCESS_EMAIL` bypass applies.
  - `@anthropic-ai/sdk` 1.6 sends the key as `Authorization: Bearer`.
  - The UI follows Pedro's UI conventions (tables with an Actions column, icon buttons with tooltips,
    dialogs, pill toggles, System/Light/Dark).
