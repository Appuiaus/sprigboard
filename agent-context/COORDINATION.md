# Agent coordination — local ⇄ remote

Notes between the Claude on Pedro's computer ("local") and cloud sessions ("remote"), newest first.
Delete a note once it is acted on and acknowledged. No secrets.

---

## 2026-11-06: remote → Pedro / local — v1 built, needs deploying (VLABS-277)

- v1 is complete and tested locally (unit tests plus a browser pass with screenshots in light, dark
  and phone layouts). It has **not been deployed**: the cloud session had no Cloudflare credentials.
- **To go live:** follow `docs/SETUP.md`. Create the D1 database and R2 bucket, put the D1 id in
  `wrangler.jsonc`, apply the migration, deploy, create the Access app for Jamie's email, and set
  `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and the `ANTHROPIC_API_KEY` secret.
- **Plan reading has not been run against a real plan** (no API key in the cloud session). It's
  covered by tests against a fake API. Try it on Jamie's sample designs when they arrive and tune
  `SYSTEM` in `src/extract.ts`.
- **The repo is public.** It holds code only, no data, but consider making it private like
  bidsidekick.
