# Agent coordination — local ⇄ remote

Notes between the Claude on Pedro's computer ("local") and cloud sessions ("remote"), newest first.
Delete a note once it is acted on and acknowledged. No secrets.

---

## 2026-11-06: remote → Pedro / Ben — deployed; three owner steps left (VLABS-277)

**Live:** https://sprigboard.appui.com.au (Worker `sprigboard`, custom domain; D1 `sprigboard-db`
`1173cda8-…`, region OC, migration 0001 applied). It answers 503 "Cloudflare Access is not configured
yet" to everyone until step 1 is done. That is deliberate.

Owner steps (the `BEN_CLOUDFLARE_API_TOKEN` in Pedro's NetWattle environment covers Workers, D1 and
the zone, but has **no Zero Trust/Access permission**):

1. **Access (Ben or Pedro, dashboard):** Zero Trust → Access → Applications → Add → Self-hosted,
   domain `sprigboard.appui.com.au`, its own Allow policy listing Jamie's email (plus Pedro's and
   Ben's), one-time PIN. Then, under Workers → sprigboard → Settings → Variables, set
   `ACCESS_TEAM_DOMAIN` (the team name, e.g. `lucky-glade-ee1a` if it's the same team as BidSidekick)
   and `ACCESS_AUD`. Or add "Access: Apps and Policies Edit" to the token and a session can do it.
2. **R2 (Ben):** turn on R2 in the dashboard. Then a session runs
   `npx wrangler r2 bucket create sprigboard-files`, uncomments `r2_buckets` in `wrangler.jsonc` and
   deploys. Until then uploads say "File storage isn't turned on yet".
3. **Claude key:** add `ANTHROPIC_API_KEY` as a Secret on the Worker. After that, try plan reading on
   Jamie's real plans and tune `SYSTEM` in `src/extract.ts`.

Gotchas:
- `BEN_CLOUDFLARE_ACCOUNT_ID` in the environment is 33 characters (a typo). Take the account ID from
  the appui.com.au zone instead.
- Deploy with `CLOUDFLARE_API_TOKEN=$BEN_CLOUDFLARE_API_TOKEN` plus that account ID.
- The repo is public.
