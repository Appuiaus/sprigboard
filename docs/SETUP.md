# Setup: Sprigboard on Ben's Cloudflare account

**Live:** https://sprigboard.appui.com.au (Worker `sprigboard`; D1 `sprigboard-db`, region OC).
Everything here is separately named. Nothing else in the account or the `appui.com.au` zone is touched,
apart from the DNS record Cloudflare added for the custom domain.

Deploy with Ben's token (the `BEN_CLOUDFLARE_API_TOKEN` in Pedro's NetWattle cloud environment). The
environment's `BEN_CLOUDFLARE_ACCOUNT_ID` has a typo, so take the account ID from the zone:

```sh
export CLOUDFLARE_API_TOKEN="$BEN_CLOUDFLARE_API_TOKEN"
export CLOUDFLARE_ACCOUNT_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=appui.com.au" | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['account']['id'])")
npx wrangler d1 migrations apply sprigboard-db --remote
npx wrangler deploy
```

## Sign-in

Sprigboard has its own sign-in, so nobody needs a Cloudflare account and there is **no Cloudflare Access app** in
front of it. (If one is ever created for sprigboard.appui.com.au, delete it, or visitors get an extra
Cloudflare login screen.) People sign in with:

- email and password (PBKDF2-SHA256, 100,000 iterations, salted; a lockout after 8 wrong tries in 15 minutes);
- a 6-digit code emailed to them (10 minutes, 5 tries);
- a passkey (Face ID, Touch ID, Windows Hello or a phone), added on the Account page.

There is also forgot password (a one-hour, single-use link), invites from the Users page (a 7-day link), change
password, and sign out everywhere. Sessions last 30 days in an HttpOnly, SameSite=Lax cookie. Only hashes of
passwords, codes, links and session tokens are stored.

### Variables and secrets on the Worker

| Name | Kind | Value |
|---|---|---|
| `APP_URL` | var (wrangler.jsonc) | `https://sprigboard.appui.com.au`. Used for emailed links and as the passkey domain |
| `MAIL_FROM` | var (wrangler.jsonc) | `Sprigboard <noreply@velosolabs.com>`. Must be a sender validated in Mailjet |
| `PASSWORD_ITERATIONS` | var (wrangler.jsonc) | `100000` |
| `BOOTSTRAP_EMAILS` | **secret**, set | `pedro@veloso.dev,bhmorg82@gmail.com`. These may sign in by code before they have an account, and become owners |
| `MAILJET_API_KEY`, `MAILJET_API_SECRET` | **secret, owner to add** | The same Mailjet API key and secret as velosolabs' SMTP login |
| `ANTHROPIC_API_KEY` | **secret, owner to add** | Plan reading |

Add a secret with `npx wrangler secret put NAME`, or in the dashboard under Workers & Pages → sprigboard →
Settings → Variables and Secrets → Add → Secret.

### First sign-in

1. Add the two Mailjet secrets.
2. Open https://sprigboard.appui.com.au → **Email me a sign-in code instead** → enter `pedro@veloso.dev`
   (or Ben's address). The code signs you in as an owner. Then set a password and/or add a passkey on the
   Account page.
3. **Users → +**: invite Jamie (choose Owner if she should manage users too). She gets an email to choose a password.

**Without email:** create an account directly. This prompts for the password and stores only its hash:

```sh
node tools/create-user.mjs pedro@veloso.dev "Pedro" owner --remote
```

Then sign in with that password, and invite Jamie from Users. While email is off, the invite link is shown on
screen so you can send it to her yourself.

## File storage (R2): waiting on Ben

R2 isn't enabled on Ben's account. Until it is, uploading plans, plant graphics and logos shows "File storage
isn't turned on yet"; everything else works. Once Ben enables R2 (dashboard → R2 → Overview):

```sh
npx wrangler r2 bucket create sprigboard-files
# uncomment "r2_buckets" in wrangler.jsonc, then:
npx wrangler deploy
```

## CPU limits (Workers Free)

Ben's account is on Workers Free (10 ms CPU per request), by owner decision. Measured:

- **Password hashing:** about 16 ms of CPU locally at 100,000 iterations. The live site handled ten in a row on 2026-11-07
  without a CPU-limit error (1102). If 1102 errors ever appear on sign-in, set `PASSWORD_ITERATIONS` to `50000`.
  Each account's hash upgrades or downgrades itself the next time that person signs in.
- **Plan reading:** the plan goes to Claude through the Anthropic Files API (upload, read, delete), so the Worker
  never base64-encodes a large PDF.
- **Passkeys:** ES256 signature checks are cheap.

## Develop locally

```sh
npm install
printf 'MAIL_MODE="log"\nBOOTSTRAP_EMAILS="you@example.com"\nAPP_URL="http://localhost:8787"\n' > .dev.vars
npx wrangler d1 migrations apply sprigboard-db --local
npx wrangler dev --ip localhost --local-upstream localhost   # http://localhost:8787
```

`MAIL_MODE="log"` prints emails (codes and links) to the terminal. Use `localhost`, not `127.0.0.1`:
passkeys need a domain name.
