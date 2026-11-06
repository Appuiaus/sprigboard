// Verifies the Cloudflare Access JWT on every request. Fails closed: if Access
// is not configured, or the token is missing/invalid, nothing is served.

export interface AccessEnv {
  ACCESS_TEAM_DOMAIN: string; // team name, e.g. "lucky-glade-ee1a"
  ACCESS_AUD: string;         // Application Audience (AUD) tag from the Access app
}

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }

let cachedKeys: { at: number; domain: string; keys: Jwk[] } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function issuer(env: AccessEnv): string {
  const d = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\.cloudflareaccess\.com\/?$/, "");
  return `https://${d}.cloudflareaccess.com`;
}

async function getKeys(env: AccessEnv): Promise<Jwk[]> {
  const iss = issuer(env);
  if (cachedKeys && cachedKeys.domain === iss && Date.now() - cachedKeys.at < 3_600_000) return cachedKeys.keys;
  const res = await fetch(`${iss}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs fetch failed: ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  cachedKeys = { at: Date.now(), domain: iss, keys: body.keys };
  return body.keys;
}

export type AccessResult = { ok: true; email: string } | { ok: false; status: number; reason: string };

// Set by Cloudflare when Worker-level Access authenticated this request.
export interface AccessContext {
  aud: string;
  getIdentity(): Promise<{ email?: string } | undefined>;
}

export async function verifyAccess(req: Request, env: AccessEnv, access?: AccessContext): Promise<AccessResult> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return { ok: false, status: 503, reason: "Cloudflare Access is not configured yet. See docs/SETUP.md." };
  }
  // Preferred path: Worker-level Access already verified the user before this
  // code ran. Still pin it to our application's audience.
  if (access) {
    if (access.aud !== env.ACCESS_AUD) return { ok: false, status: 403, reason: "Wrong audience." };
    const identity = await access.getIdentity();
    return { ok: true, email: identity?.email ?? "unknown" };
  }
  // Fallback: verify the Access JWT header ourselves.
  const token = req.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { ok: false, status: 403, reason: "Missing Access token." };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, status: 403, reason: "Malformed token." };
  const [h, p, sig] = parts;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { kid: string; alg: string };
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as {
      aud: string | string[]; exp: number; iss: string; email?: string;
    };
    if (header.alg !== "RS256") return { ok: false, status: 403, reason: "Unexpected algorithm." };
    const jwk = (await getKeys(env)).find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, status: 403, reason: "Unknown signing key." };
    const key = await crypto.subtle.importKey(
      "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`),
    );
    if (!valid) return { ok: false, status: 403, reason: "Bad signature." };
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!auds.includes(env.ACCESS_AUD)) return { ok: false, status: 403, reason: "Wrong audience." };
    if (payload.iss !== issuer(env)) return { ok: false, status: 403, reason: "Wrong issuer." };
    if (payload.exp * 1000 < Date.now()) return { ok: false, status: 403, reason: "Token expired." };
    return { ok: true, email: payload.email ?? "unknown" };
  } catch (e) {
    return { ok: false, status: 403, reason: "Token verification failed." };
  }
}
