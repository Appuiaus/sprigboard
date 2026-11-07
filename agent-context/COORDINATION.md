# Agent coordination — local ⇄ remote

Notes between the Claude on Pedro's computer ("local") and cloud sessions ("remote"), newest first.
Delete a note once it is acted on and acknowledged. No secrets.

---

## 2026-11-07: remote → Pedro / Ben — own sign-in and passkeys live; owner steps (VLABS-277)

https://sprigboard.appui.com.au is deployed with Sprigboard's own sign-in: password, emailed code, passkeys,
reset and invites. **Cloudflare Access is no longer used**, so don't create an Access app for sprigboard. Owner
steps, in order:

0. **Later (Pedro), VLABS-296:** an appui.com.au email sender for Ben's apps. Until then Sprigboard uses the velosolabs Mailjet account (Pedro's decision, 2026-11-07).
1. **Mailjet secrets (Pedro):** add `MAILJET_API_KEY` and `MAILJET_API_SECRET` to the sprigboard Worker
   (`wrangler secret put` or the dashboard). Use the velosolabs Mailjet key, with sender
   `noreply@velosolabs.com` (it must be validated in Mailjet). **Until then nobody can sign in by code.** The
   alternative is `node tools/create-user.mjs pedro@veloso.dev "Pedro" owner --remote` (prompts for a password).
2. **First sign-in:** request a code for pedro@veloso.dev or bhmorg82@gmail.com (`BOOTSTRAP_EMAILS`), then invite
   Jamie from Users. We don't have Jamie's email address yet.
3. **R2 (Ben):** enable it. Then create `sprigboard-files`, uncomment `r2_buckets` and deploy.
4. **`ANTHROPIC_API_KEY`** secret for plan reading. Then test on Jamie's real plans and tune `SYSTEM` in
   `src/extract.ts`.

Also outstanding, outside Sprigboard: BidSidekick's Access app (the old "bid-scout" one) has an empty Worker
destination, so bidsidekick.appui.com.au answers 403 "Missing Access token" to everyone. The fix is in the
dashboard (the token has no Access scope): point that app at the `bidsidekick` Worker plus the public hostname
`bidsidekick.appui.com.au`, and keep its AUD.

Note: velosolabs main now has a narrow BidSidekick sign-in-code email relay on the hub (VLABS-295, `app/relay.py`), so
another session may be moving BidSidekick to its own sign-in; check that before fixing its Access app. That relay
could be generalised for Sprigboard (codes plus reset and invite links) as an alternative to Mailjet secrets on Ben's
Worker, but that's a hub PR for Pedro to merge.

Gotchas: `BEN_CLOUDFLARE_ACCOUNT_ID` has a typo (take the ID from the zone). The repo is public.
