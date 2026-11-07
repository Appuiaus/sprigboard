# Sprigboard

Jamie's landscape-plan studio, at **https://sprigboard.appui.com.au** (Ben's domain, next to
BidSidekick). Jamie redraws landscape design plans as presentation drawings in Illustrator.
Sprigboard handles the work around the drawing:

| Area | What it does |
|---|---|
| **Sign-in** | Sprigboard's own accounts (no Cloudflare account needed): email and password, emailed 6-digit codes, **passkeys**, forgot password, invites, and a Users page for owners. |
| **Jobs** | Search and status filters, with a summary of new, drawing and sent jobs and unpaid invoices. One record per drawing job, with the next job number (J-0001, …), client, project, site address, scale, size and status. |
| **Plans** | Upload the plan files (PDF, JPEG, PNG) for a job. They are stored in R2. |
| **Plan reading** | Claude (`claude-opus-5-5`) reads a plan and drafts a checklist of plants, street names, dimensions, markings and notes. Jamie ticks each item off against the plan; the AI drafts, she decides. Blank job fields (scale, address) are filled from the plan, never overwritten. |
| **Plant library** | CSV import and download. Jamie's plant graphics, with botanical name, common name and plan code. Checklist plants are matched by code, then exact name, then genus and species, then genus (weaker matches are flagged). |
| **Title block** | Scale, client, project, address, date, disclaimer ("Not for construction" by default), the client's copyright line and "drawn by" are exported per job as an Illustrator variable library (XML) or a CSV data set. |
| **Time** | A start/stop timer and hand-entered time on each job. Settings shows how long each job size takes on average and what its price works out to per hour, which Jamie uses to set prices (she doesn't bill by the hour). |
| **Pricing** | Fixed prices by job size (Small, Medium, Large, Extra large, all editable), not by the hour. |
| **Invoices** | Jamie's own logo at the top; email an invoice to the client (replies go to her) once email is set up. Created from a job at its size price, numbered on from Jamie's last paper invoice, with GST handled by two Settings switches ("Registered for GST" and "Add GST to invoices") plus an on/off switch on each invoice, payment details, draft/sent/paid status, overdue flag, and print or save as PDF from the browser. |

**Settings** (`src/settings.ts`): every business choice is a setting Jamie changes herself, in seven sections:
business details; invoices and GST (rate, line wording, default notes, payment terms); numbering (prefixes,
digits); invoice emails (sender name, subject and message templates); plans (extra instructions for Claude,
species and genus matching); job status names; time zone and the getting-started checklist.

**File viewer:** every stored or exported file opens in a pop-up. PDFs (drawn with PDF.js, so they work on
phones), Illustrator files saved PDF-compatible, images, CSV exports as tables, XML/JSON/text, video and audio.
EPS, legacy .ai and Office files get a download.

A getting-started checklist on the Jobs page walks through the first setup and can be hidden.
Until R2 is enabled, files up to 1 MB (plant graphics, logos, small plans) are stored in D1 (`src/storage.ts`); bigger PDFs need R2.
Owners can download all the data as JSON (Settings → download icon). The export holds no password hashes or other secrets.
Every page carries Pedro's binary-dot site signature (the same mark as veloso.dev and velosolabs.com).

Out of scope: the drawing itself, and exporting and downsampling in Illustrator (Jamie's own Actions do that).

## Stack

Cloudflare Worker (TypeScript, no framework) on Workers Free, D1 (data), R2 (files), its own sign-in
(`src/auth.ts`, `src/passkeys.ts` with @simplewebauthn/server), Mailjet for email (`src/mail.ts`), and the
Anthropic API through the Files API for plan reading (`src/extract.ts`). The same pattern as BidSidekick, with its own resources
and data. See [`docs/SETUP.md`](docs/SETUP.md) to deploy and [`docs/BRIEF.md`](docs/BRIEF.md) for
the requirements.

## Develop

```sh
npm install
npm test            # unit tests (vitest), including plan reading against a fake Claude API
npm run typecheck
npx wrangler d1 migrations apply sprigboard-db --local
printf 'MAIL_MODE="log"\nBOOTSTRAP_EMAILS="you@example.com"\nAPP_URL="http://localhost:8787"\n' > .dev.vars
npx wrangler dev --ip localhost --local-upstream localhost   # http://localhost:8787
```

Sign in with "Email me a sign-in code": the code appears in the terminal. Plan reading also needs
`ANTHROPIC_API_KEY` in `.dev.vars`.
