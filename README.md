# Sprigboard

Jamie's landscape-plan studio, at **https://sprigboard.appui.com.au** (Ben's domain, next to
BidSidekick). Jamie redraws landscape design plans as presentation drawings in Illustrator.
Sprigboard handles the work around the drawing:

| Area | What it does |
|---|---|
| **Jobs** | One record per drawing job, with the next job number (J-0001, …), client, project, site address, scale, size and status. |
| **Plans** | Upload the plan files (PDF, JPEG, PNG) for a job. They are stored in R2. |
| **Plan reading** | Claude (`claude-opus-5-5`) reads a plan and drafts a checklist of plants, street names, dimensions, markings and notes. Jamie ticks each item off against the plan; the AI drafts, she decides. Blank job fields (scale, address) are filled from the plan, never overwritten. |
| **Plant library** | Jamie's plant graphics, with botanical name, common name and plan code. Checklist plants are matched by code, then exact name, then genus and species, then genus (weaker matches are flagged). |
| **Title block** | Scale, client, project, address, date, disclaimer ("Not for construction" by default), the client's copyright line and "drawn by" are exported per job as an Illustrator variable library (XML) or a CSV data set. |
| **Pricing** | Fixed prices by job size (Small, Medium, Large, Extra large, all editable), not by the hour. |
| **Invoices** | Created from a job at its size price, numbered on from Jamie's last paper invoice, with optional 10% GST, payment details, draft/sent/paid status, overdue flag, and print or save as PDF from the browser. |

Out of scope: the drawing itself, and exporting and downsampling in Illustrator (Jamie's own Actions do that).

## Stack

Cloudflare Worker (TypeScript, no framework), D1 (data), R2 (files), Cloudflare Access (sign-in,
fails closed), Anthropic API (plan reading). The same pattern as BidSidekick, with its own resources
and data. See [`docs/SETUP.md`](docs/SETUP.md) to deploy and [`docs/BRIEF.md`](docs/BRIEF.md) for
the requirements.

## Develop

```sh
npm install
npm test            # unit tests (vitest), including plan reading against a fake Claude API
npm run typecheck
npx wrangler d1 migrations apply sprigboard-db --local
echo 'DEV_ACCESS_EMAIL="you@example.com"' > .dev.vars
npx wrangler dev --local-upstream localhost   # http://localhost:8787
```

`DEV_ACCESS_EMAIL` skips Access only when the request is to `localhost`, so it has no effect on the
deployed site. Plan reading needs `ANTHROPIC_API_KEY` in `.dev.vars` as well.
