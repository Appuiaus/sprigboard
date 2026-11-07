# Sprigboard

Jamie's landscape-plan studio (see README.md, docs/BRIEF.md, docs/SETUP.md). Jira: VLABS-277,
under epic VLABS-264, assigned to Pedro Veloso. Keep the ticket current as work happens.

## Agent working context

Fetch or pull first, then read `agent-context/COORDINATION.md` (open to-dos between sessions) and
`agent-context/JOURNAL.md` (curated history and gotchas). Update both before the session ends.
No secrets in either.

## Rules

- **Commit identity:** every commit is by `Pedro Veloso <pedro@veloso.dev>`, never an AI author, with
  no AI trailers or footers (no `Co-Authored-By: Claude`, no session links).
- **Ben's account:** touch only `sprigboard` resources (Worker, `sprigboard-db`, `sprigboard-files`,
  the Sprigboard Access app). Never change Ben's other Workers, DNS records, tunnels or BidSidekick.
- **No secrets in git.** `ANTHROPIC_API_KEY` is a Worker secret; `ACCESS_*` are dashboard variables.
- **The AI drafts, Jamie decides.** Plan reading produces a checklist she confirms. Never let it
  overwrite what she typed.
- **UI conventions (Pedro's, 2026-10-28):** lists are tables with an Actions column of small icon
  buttons (tooltip plus `aria-label`, danger style for deletes); add, edit and delete happen in dialogs;
  deletes ask for confirmation; checkboxes are pill toggles; radios are pills; System/Light/Dark mode.
  Check every UI change with screenshots in light, dark and at phone width.
- **Claude API:** model `claude-opus-5-5`, structured output via `output_config.format`, server-side
  `fallbacks: "default"`. Check the current API docs before changing it.
- Run `npm test` and `npm run typecheck` before pushing.
- **Always ship (owner's rule, 2026-11-07):** "Always deploy, develop, merge, push, keep going." Don't stop to
  ask before committing, pushing, merging or deploying Sprigboard. Once tests pass and the screenshots are checked,
  ship it, then pick up the next useful task. Still stop for things only Pedro or Ben can do (secrets, repo
  settings, enabling R2), and before anything that spends money or deletes real data.
- **Settings over code (owner's rule, 2026-11-07):** anything Jamie might reasonably want to change (wording,
  rates, numbering, names, defaults, on/off behaviour, time zone) is a setting, never a hard-coded value, so she
  never has to ask for a code change. Add it as one entry in `src/settings.ts` (`SETTINGS`: label, type, section,
  default, hint, limits). The Settings page, validation, defaults and saving all follow from that entry. Read it
  as `c.st.<key>`. Don't add a migration for a new setting; the default covers it. When building any feature,
  ask what a user would want to adjust, and make that a setting from the start.
- **This repo and BidSidekick's (`Appuiaus/bidsidekick`) must be private** (owner's rule, 2026-11-07). If either
  shows as public (check with `gh api -X GET search/repositories -f q='user:Appuiaus'`), tell Pedro straight away.
  Never commit client data, plans or secrets to them either way.

## Creating repositories (owner's rule, 2026-11-06)

When a project needs a new GitHub repository, create it yourself without asking Pedro first:
private by default, under the right owner (`s2925534` for Pedro's projects, `Appuiaus` for Ben's
apps), named after the product. Where the session cannot create repositories (cloud sessions block
it), tell Pedro straight away the exact owner, name and visibility to create, and keep building
locally until it exists. Then attach it and push.

## Login standard (owner's rule, 2026-11-07, all of Pedro's web apps)

Every web app in Pedro's ecosystem, current or new, has its **own** sign-in. It never depends on someone
having an account with a third party (for example Cloudflare Access or a Google login). At minimum it offers:

- **email (or username) and password**: a slow, salted hash (PBKDF2, scrypt or Argon2), rate limits, and a
  lockout after repeated failures;
- **passkeys** (WebAuthn): added from the account page, and usable without typing an email (discoverable
  credentials);
- **a one-time code sent by email**: short-lived, single use, with a limited number of tries.

Also: forgot password (a single-use reset link), invites where an app has more than one user, change password,
and sign out everywhere. Give the same answer whether or not an account exists. Build emailed links from a
configured site address, never the request's Host header. Store only hashes of passwords, codes, links and
session tokens. Use HttpOnly, SameSite session cookies and refuse cross-site form posts.

Reference implementation: `Appuiaus/sprigboard` (`src/auth.ts`, `src/passkeys.ts` with
@simplewebauthn/server, `src/mail.ts`; VLABS-277). An existing app that lacks any of the three methods gets a
Jira ticket to add them, and new apps ship with all three from the first release.
