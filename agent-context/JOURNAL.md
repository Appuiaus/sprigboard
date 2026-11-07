# Journal

Curated, newest first: what each session did and why, with gotchas for the next session.

## 2026-11-07: own sign-in, passkeys, Workers Free tuning (cloud session)

- **Why:** Pedro: Jamie must not need a Cloudflare account. So Cloudflare Access was replaced by Sprigboard's own
  sign-in (`src/auth.ts`): email and password, emailed codes, reset links, invites and a Users page. Passkeys were
  added on Pedro's request (`src/passkeys.ts`, @simplewebauthn/server v14, discoverable credentials, so no email is
  needed at sign-in).
- **Decisions:**
  - Pedro chose Mailjet with sender `noreply@velosolabs.com` and the HTTP Send API (Workers can't speak SMTP easily).
  - First owners come from the `BOOTSTRAP_EMAILS` secret (Pedro and Ben); Jamie gets an invite.
  - Ben stays on Workers Free (owner decision). Measured PBKDF2 at about 16 ms per 100k iterations locally; live, ten
    hashes in a row ran without 1102, so it stays at 100k. Each stored hash carries its own iteration count and is
    re-hashed at sign-in when the setting changes.
  - Plan reading moved to the Files API (upload, read, delete in `finally`), so no base64 encoding in the Worker.
  - Emailed links use `APP_URL`, never the Host header. Answers are the same whether or not an account exists.
    Rate limits are fixed-window rows in D1.
  - Pedro's binary-dot site signature (byte-for-byte veloso.dev's) is on every page.
  - Also: job search and filters with a summary, plant CSV import and download, and an owner JSON export with no secrets.
- **Gotchas:**
  - Passkeys need a domain, so develop on `localhost`, not `127.0.0.1`.
  - Chrome logs 401 pages as console errors; the e2e filters those.
  - Deleting `.wrangler/state` under a running `wrangler dev` breaks it; restart dev.
  - A heredoc in Bash tripped the harness's rm-safety parser; use the Write tool for new files.

## 2026-11-06: first deploy (cloud session)

- Deployed to Ben's account: Worker `sprigboard` on the custom domain sprigboard.appui.com.au, and D1
  `sprigboard-db` created in OC (Oceania) for Jamie's latency. A first copy was created in ENAM by
  default; it was empty and deleted at once.
- R2 is not enabled on the account, so `FILES` is optional in code. Uploads show a clear notice
  instead of failing, and the binding is commented out in `wrangler.jsonc` until Ben turns R2 on.
- The token has no Access scope, so the Access app is an owner step. The site fails closed (503)
  until then.

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
