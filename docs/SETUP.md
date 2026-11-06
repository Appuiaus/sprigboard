# Setup: deploying Sprigboard on Ben's Cloudflare account

Everything here is new and separately named. Nothing existing in the account or the
`appui.com.au` zone is changed, apart from the one DNS record Cloudflare adds for the custom domain.

## 1. Create the resources (once)

```sh
npx wrangler login                       # or CLOUDFLARE_API_TOKEN for Ben's account
npx wrangler d1 create sprigboard-db     # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create sprigboard-files
npx wrangler d1 migrations apply sprigboard-db --remote
```

## 2. Deploy

```sh
npx wrangler deploy
```

The `routes` entry in `wrangler.jsonc` attaches **sprigboard.appui.com.au** as a custom domain;
Cloudflare creates the DNS record and certificate. (As with BidSidekick, you can instead connect the
GitHub repo under Workers & Pages → sprigboard → Settings → Build so every push to `main` deploys.)

Until Access is set up (step 3), every page answers **503**. That is deliberate.

## 3. Cloudflare Access (sign-in)

Zero Trust → Access → Applications → Add → Self-hosted:

- Name: `Sprigboard`. Domain: `sprigboard.appui.com.au`.
- Policy: **Allow**, include **Emails**: Jamie's address (plus Pedro's or Ben's if they need it).
  Give it its own policy; don't reuse BidSidekick's.
- Login method: One-time PIN (or Google).
- Copy the **Application Audience (AUD) tag**.

Then in Workers & Pages → sprigboard → Settings → Variables and Secrets:

| Name | Type | Value |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | Text | the Zero Trust team name (e.g. `lucky-glade-ee1a`) |
| `ACCESS_AUD` | Text | the AUD tag from above |
| `ANTHROPIC_API_KEY` | **Secret** | an Anthropic API key (console.anthropic.com), billed to whoever owns it |

`keep_vars` in `wrangler.jsonc` stops later deploys from wiping these.

## 4. First use (Jamie)

1. **Settings:** business name, ABN, email, payment details, whether she is registered for GST,
   and her last paper invoice number in "Carry on from your last invoice" (e.g. `INV-0041`).
   Set a price for each job size once she has timed a few jobs.
2. **Clients:** add Shane's business with the copyright statement and logo he supplies.
3. **Plant library:** add her plant graphics (SVG or PNG show a preview; AI and EPS are stored for download).
4. **Jobs:** + → new job → upload the plan → ✦ to have Claude read it → tick items off while drawing →
   download the title block for Illustrator → 🧾 to invoice.

## Cost

- Cloudflare: Workers, D1 and R2 free tiers cover this comfortably.
- Claude: each plan read is one request to `claude-opus-5-5` ($4 per million input tokens, $20
  per million output). A typical one- or two-page plan costs a few cents; a large multi-page PDF
  costs more. Requests that hit a safety decline are retried server-side on a fallback model
  (`fallbacks: "default"`).
