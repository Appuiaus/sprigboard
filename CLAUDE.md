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
