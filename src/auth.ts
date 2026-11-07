// Sprigboard's own sign-in: email + password, or a 6-digit code sent by email; password
// reset and invite links; sessions in an HttpOnly cookie; owner-managed users.
// Only hashes of passwords, codes, links and session tokens are stored.

import { esc } from "./lib";
import { mailEnabled, sendMail, type MailEnv } from "./mail";
import { field, iconBtn, icon, layoutBare, table, badge, formDialog, confirmDelete, pills, layout, dialog } from "./ui";
import { listPasskeys, deviceName, PASSKEY_JS } from "./passkeys";

export interface AuthEnv extends MailEnv {
  DB: D1Database;
  /** Comma-separated emails that may sign in by code before they have an account; they become owners. */
  BOOTSTRAP_EMAILS?: string;
  /** PBKDF2 iterations for new hashes (default 100000, the Workers maximum). */
  PASSWORD_ITERATIONS?: string;
  /** The site's public address, e.g. https://sprigboard.appui.com.au. Used in emailed links and as the passkey domain. */
  APP_URL?: string;
}

/** Links in emails use the configured address, never the request's Host header. */
export const appUrl = (env: AuthEnv, url: URL) => (env.APP_URL || url.origin).replace(/\/+$/, "");

export interface User { id: number; email: string; name: string; role: "owner" | "member"; has_password: boolean }

const enc = new TextEncoder();
export const SESSION_COOKIE = "sb_session";
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const RESET_MINUTES = 60;
const INVITE_DAYS = 7;
const MAX_CODE_ATTEMPTS = 5;
export const MIN_PASSWORD = 10;
const MAX_ITERATIONS = 100_000; // workerd's PBKDF2 limit

// ---------- crypto helpers ----------

const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u8: Uint8Array) => b64(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** A uniformly random 6-digit code. */
export function randomCode(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4_294_000_000); // reject the biased tail
  return String(n % 1_000_000).padStart(6, "0");
}

export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function iterationsFor(env: { PASSWORD_ITERATIONS?: string }): number {
  const n = Number(env.PASSWORD_ITERATIONS || MAX_ITERATIONS);
  return Number.isInteger(n) && n >= 10_000 ? Math.min(n, MAX_ITERATIONS) : MAX_ITERATIONS;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = MAX_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(await pbkdf2(password, salt, iterations))}`;
}

export async function verifyPassword(password: string, stored: string, wantIterations = MAX_ITERATIONS): Promise<{ ok: boolean; rehash: boolean }> {
  const [alg, it, salt, hash] = stored.split("$");
  if (alg !== "pbkdf2-sha256" || !it || !salt || !hash) return { ok: false, rehash: false };
  const got = b64(await pbkdf2(password, unb64(salt), Number(it)));
  const ok = safeEqual(got, hash);
  return { ok, rehash: ok && Number(it) !== wantIterations };
}

export function passwordProblem(pw: string, confirm: string, email = ""): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > 200) return "That password is too long.";
  if (pw !== confirm) return "The two passwords don't match.";
  if (email && pw.toLowerCase().includes(email.split("@")[0].toLowerCase()) && email.split("@")[0].length >= 4) return "Don't use your email name in the password.";
  if (/^(.)\1+$/.test(pw) || /^(0123456789|1234567890|password\d*|qwertyuiop)/i.test(pw)) return "That password is too easy to guess.";
  return null;
}

export const normEmail = (s: unknown) => String(s ?? "").trim().toLowerCase();
const validEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254;

// ---------- rate limits ----------

/** Counts one event for key; returns false once count exceeds limit within the window. */
export async function rateLimit(env: AuthEnv, key: string, limit: number, windowSec: number, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const start = now - (now % windowSec);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
                                     window_start = excluded.window_start
     RETURNING count`,
  ).bind(key, start).first<{ count: number }>();
  return (row?.count ?? 1) <= limit;
}

async function overLimit(env: AuthEnv, key: string, limit: number, windowSec: number, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const start = now - (now % windowSec);
  const row = await env.DB.prepare(`SELECT count FROM rate_limits WHERE key=? AND window_start=?`).bind(key, start).first<{ count: number }>();
  return (row?.count ?? 0) >= limit;
}

// ---------- sessions ----------

const plusSql = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);

function cookie(req: Request, value: string, maxAge: number): string {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Creates a session and returns its Set-Cookie value. */
export async function sessionCookie(env: AuthEnv, req: Request, userId: number): Promise<string> {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES (?,?,?,?)`)
      .bind(await sha256(token), userId, plusSql(SESSION_DAYS * 1440), (req.headers.get("user-agent") ?? "").slice(0, 200)),
    env.DB.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id=?`).bind(userId),
    env.DB.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`),
  ]);
  return cookie(req, token, SESSION_DAYS * 86400);
}

export async function startSession(env: AuthEnv, req: Request, userId: number, to = "/"): Promise<Response> {
  return new Response(null, { status: 303, headers: { location: safeNext(to), "set-cookie": await sessionCookie(env, req, userId) } });
}

export async function currentUser(env: AuthEnv, req: Request): Promise<User | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || token.length > 100) return null;
  const h = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role, u.password_hash IS NOT NULL AS has_password, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.deleted_at IS NULL`,
  ).bind(h).first<Record<string, unknown>>();
  if (!row) return null;
  // Slide the expiry at most once an hour.
  if (String(row.last_seen_at) < plusSql(-60)) {
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = datetime('now'), expires_at = ? WHERE token_hash = ?`).bind(plusSql(SESSION_DAYS * 1440), h).run();
  }
  return { id: Number(row.id), email: String(row.email), name: String(row.name), role: row.role === "owner" ? "owner" : "member", has_password: !!row.has_password };
}

async function endSession(env: AuthEnv, req: Request): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await env.DB.prepare(`DELETE FROM sessions WHERE token_hash=?`).bind(await sha256(token)).run();
}

export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

// ---------- one-time tokens ----------

async function issueToken(env: AuthEnv, purpose: "code" | "reset" | "invite", email: string, userId: number | null, minutes: number): Promise<string> {
  const secret = purpose === "code" ? randomCode() : randomToken();
  await env.DB.batch([
    // A new code or link replaces any unused earlier one of the same kind.
    env.DB.prepare(`UPDATE auth_tokens SET used_at = datetime('now') WHERE purpose=? AND email=? AND used_at IS NULL`).bind(purpose, email),
    env.DB.prepare(`INSERT INTO auth_tokens (purpose, email, user_id, token_hash, expires_at) VALUES (?,?,?,?,?)`)
      .bind(purpose, email, userId, await sha256(`${purpose}:${email}:${secret}`), plusSql(minutes)),
    env.DB.prepare(`DELETE FROM auth_tokens WHERE expires_at < datetime('now', '-1 day')`),
  ]);
  return purpose === "code" ? secret : `${b64url(enc.encode(email))}.${secret}`;
}

/** Finds a valid reset or invite link; the link carries the email so the hash can be checked. */
async function findLink(env: AuthEnv, link: string): Promise<{ id: number; email: string; user_id: number | null; purpose: string } | null> {
  const [e, secret] = link.split(".");
  if (!e || !secret || link.length > 200) return null;
  let email: string;
  try { email = atob(e.replace(/-/g, "+").replace(/_/g, "/")); } catch { return null; }
  for (const purpose of ["reset", "invite"]) {
    const row = await env.DB.prepare(
      `SELECT id, email, user_id, purpose FROM auth_tokens WHERE token_hash=? AND purpose=? AND used_at IS NULL AND expires_at > datetime('now')`,
    ).bind(await sha256(`${purpose}:${email}:${secret}`), purpose).first<{ id: number; email: string; user_id: number | null; purpose: string }>();
    if (row) return row;
  }
  return null;
}

// ---------- emails ----------

function emailHtml(heading: string, body: string, action?: { href: string; label: string }): string {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1d231c">
  <p style="font-weight:700;color:#3f7d4e;font-size:18px;margin:0 0 16px">Sprigboard</p>
  <h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>${body}
  ${action ? `<p style="margin:24px 0"><a href="${esc(action.href)}" style="background:#3f7d4e;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${esc(action.label)}</a></p><p style="font-size:13px;color:#5f6b5c">Or paste this address into your browser:<br>${esc(action.href)}</p>` : ""}
  <p style="font-size:13px;color:#5f6b5c;margin-top:24px">If you didn't ask for this, you can ignore this email.</p></div>`;
}

// ---------- pages ----------

type AuthCtx = { env: AuthEnv; req: Request; url: URL };

const authPage = (title: string, body: string, flash?: { msg: string; err?: boolean } | null, status = 200, script = "") => layoutBare({ title, body, flash, status, script });

function loginPage(c: AuthCtx, flash?: { msg: string; err?: boolean } | null, email = "", status = 200): Response {
  const next = safeNext(c.url.searchParams.get("next"));
  const mail = mailEnabled(c.env);
  return authPage("Sign in", `<h1>Sign in</h1>
    <div data-passkey hidden><button type="button" class="btn wide passkey" id="passkey-login" data-next="${esc(next)}">${icon("key")}Sign in with a passkey</button>
      <div id="passkey-msg" role="status" hidden></div><div class="or"><span>or</span></div></div>
    <form method="post" action="/login?next=${encodeURIComponent(next)}" class="stack">
      ${field("email", "Email", email, { type: "email", required: true, full: true, attrs: 'autocomplete="username" autofocus' })}
      ${field("password", "Password", "", { type: "password", required: true, full: true, attrs: 'autocomplete="current-password"' })}
      <button class="btn btn-primary wide">Sign in</button>
    </form>
    <div class="alt">${mail ? `<a href="/login/code?next=${encodeURIComponent(next)}${email ? `&email=${encodeURIComponent(email)}` : ""}">${icon("sparkle")}Email me a sign-in code instead</a>
      <a href="/forgot">Forgot your password?</a>` : `<span class="muted small">Email isn't set up yet, so sign-in codes and password resets are unavailable.</span>`}</div>`, flash ?? flashOf(c.url), status, PASSKEY_JS);
}

function codeRequestPage(c: AuthCtx, flash?: { msg: string; err?: boolean } | null): Response {
  const next = safeNext(c.url.searchParams.get("next"));
  return authPage("Sign in with a code", `<h1>Sign in with a code</h1>
    <p class="sub">We'll email you a 6-digit code. No password needed.</p>
    <form method="post" action="/login/code?next=${encodeURIComponent(next)}" class="stack">
      ${field("email", "Email", c.url.searchParams.get("email") ?? "", { type: "email", required: true, full: true, attrs: 'autocomplete="email" autofocus' })}
      <button class="btn btn-primary wide">Email me a code</button></form>
    <div class="alt"><a href="/login?next=${encodeURIComponent(next)}">Sign in with a password</a></div>`, flash ?? flashOf(c.url));
}

function codeEntryPage(c: AuthCtx, email: string, flash?: { msg: string; err?: boolean } | null, status = 200): Response {
  const next = safeNext(c.url.searchParams.get("next"));
  return authPage("Enter your code", `<h1>Check your email</h1>
    <p class="sub">If <b>${esc(email)}</b> can use Sprigboard, a 6-digit code is on its way. It works for ${CODE_MINUTES} minutes.</p>
    <form method="post" action="/login/code/verify?next=${encodeURIComponent(next)}" class="stack">
      <input type="hidden" name="email" value="${esc(email)}">
      ${field("code", "Code", "", { required: true, full: true, attrs: 'inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" autofocus class="code"' })}
      <button class="btn btn-primary wide">Sign in</button></form>
    <div class="alt"><a href="/login/code?email=${encodeURIComponent(email)}&next=${encodeURIComponent(next)}">Send a new code</a><a href="/login">Back to sign in</a></div>`, flash, status);
}

function forgotPage(c: AuthCtx, flash?: { msg: string; err?: boolean } | null): Response {
  return authPage("Reset your password", `<h1>Reset your password</h1>
    <p class="sub">Enter your email and we'll send you a link to choose a new password.</p>
    <form method="post" action="/forgot" class="stack">
      ${field("email", "Email", "", { type: "email", required: true, full: true, attrs: 'autocomplete="email" autofocus' })}
      <button class="btn btn-primary wide">Send reset link</button></form>
    <div class="alt"><a href="/login">Back to sign in</a></div>`, flash ?? flashOf(c.url));
}

function resetPage(c: AuthCtx, link: string, invite: boolean, email: string, flash?: { msg: string; err?: boolean } | null, status = 200): Response {
  return authPage(invite ? "Welcome to Sprigboard" : "Choose a new password", `<h1>${invite ? "Welcome to Sprigboard" : "Choose a new password"}</h1>
    <p class="sub">${invite ? `Choose a password for <b>${esc(email)}</b>. You can also sign in with an emailed code any time.` : `For <b>${esc(email)}</b>.`}</p>
    <form method="post" action="/reset" class="stack">
      <input type="hidden" name="t" value="${esc(link)}">
      <input type="text" name="username" value="${esc(email)}" autocomplete="username" hidden>
      ${field("password", "New password", "", { type: "password", required: true, full: true, hint: `At least ${MIN_PASSWORD} characters. A short sentence works well.`, attrs: `autocomplete="new-password" minlength="${MIN_PASSWORD}" autofocus` })}
      ${field("confirm", "Type it again", "", { type: "password", required: true, full: true, attrs: 'autocomplete="new-password"' })}
      <button class="btn btn-primary wide">${invite ? "Set password and sign in" : "Save and sign in"}</button></form>`, flash, status);
}

function flashOf(url: URL) {
  const m = url.searchParams.get("m");
  return m ? { msg: m, err: url.searchParams.get("e") === "1" } : null;
}

const redirect = (to: string, msg?: string, err = false) => {
  const u = new URL(to, "https://x");
  if (msg) { u.searchParams.set("m", msg); if (err) u.searchParams.set("e", "1"); }
  return new Response(null, { status: 303, headers: { location: u.pathname + u.search } });
};

const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") ?? "local";
const bootstrapEmails = (env: AuthEnv) => (env.BOOTSTRAP_EMAILS ?? "").split(",").map(normEmail).filter(Boolean);

async function userByEmail(env: AuthEnv, email: string) {
  return env.DB.prepare(`SELECT id, email, name, role, password_hash FROM users WHERE email=? AND deleted_at IS NULL`).bind(email).first<{ id: number; email: string; name: string; role: string; password_hash: string | null }>();
}

const TOO_MANY = "Too many attempts. Wait 15 minutes, or reset your password.";

/** Public routes (sign-in, codes, reset). Returns null when the path isn't one of them. */
export async function authRoute(c: AuthCtx): Promise<Response | null> {
  const { env, req, url } = c;
  const p = url.pathname;
  const post = req.method === "POST";
  const ip = clientIp(req);

  if (p === "/login" && !post) return loginPage(c);
  if (p === "/login" && post) {
    const f = await req.formData();
    const email = normEmail(f.get("email"));
    const password = String(f.get("password") ?? "");
    if (!(await rateLimit(env, `ip:login:${ip}`, 30, 900)) || (await overLimit(env, `login:${email}`, 8, 900))) return loginPage(c, { msg: TOO_MANY, err: true }, email, 429);
    const u = await userByEmail(env, email);
    const want = iterationsFor(env);
    // Always run one hash so a missing account takes as long as a wrong password.
    const check = u?.password_hash ? await verifyPassword(password, u.password_hash, want) : (await hashPassword(password, want), { ok: false, rehash: false });
    if (!u || !check.ok) {
      await rateLimit(env, `login:${email}`, 8, 900);
      return loginPage(c, { msg: u && !u.password_hash ? "That account has no password yet. Sign in with an emailed code, then set one." : "That email and password don't match.", err: true }, email, 401);
    }
    if (check.rehash) await env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=?`).bind(await hashPassword(password, want), u.id).run();
    return startSession(env, req, u.id, url.searchParams.get("next") ?? "/");
  }

  if (p === "/login/code" && !post) return codeRequestPage(c);
  if (p === "/login/code" && post) {
    const email = normEmail((await req.formData()).get("email"));
    if (!validEmail(email)) return codeRequestPage(c, { msg: "Enter a valid email address.", err: true });
    if (!mailEnabled(env)) return codeRequestPage(c, { msg: "Email isn't set up yet, so codes can't be sent. Sign in with your password.", err: true });
    const okIp = await rateLimit(env, `ip:code:${ip}`, 20, 3600);
    const okEmail = await rateLimit(env, `code:${email}`, 5, 3600);
    if (!okIp || !okEmail) return codeRequestPage(c, { msg: "Too many codes requested. Try again in an hour, or use your password.", err: true });
    const u = await userByEmail(env, email);
    if (u || bootstrapEmails(env).includes(email)) {
      const code = await issueToken(env, "code", email, u?.id ?? null, CODE_MINUTES);
      await sendMail(env, {
        to: email, subject: `${code} is your Sprigboard sign-in code`,
        text: `Your Sprigboard sign-in code is ${code}. It works for ${CODE_MINUTES} minutes.\n\nIf you didn't ask for this, you can ignore this email.`,
        html: emailHtml("Your sign-in code", `<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:8px 0">${code}</p><p>It works for ${CODE_MINUTES} minutes.</p>`),
      });
    }
    // Same answer whether or not the account exists.
    return codeEntryPage(c, email);
  }
  if (p === "/login/code/verify" && post) {
    const f = await req.formData();
    const email = normEmail(f.get("email"));
    const code = String(f.get("code") ?? "").replace(/\s+/g, "");
    if (!(await rateLimit(env, `ip:verify:${ip}`, 40, 900))) return codeEntryPage(c, email, { msg: TOO_MANY, err: true }, 429);
    const tok = await env.DB.prepare(
      `SELECT id, user_id, token_hash, attempts FROM auth_tokens WHERE purpose='code' AND email=? AND used_at IS NULL AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`,
    ).bind(email).first<{ id: number; user_id: number | null; token_hash: string; attempts: number }>();
    if (!tok || tok.attempts >= MAX_CODE_ATTEMPTS) return codeEntryPage(c, email, { msg: "That code has expired or been used too many times. Send a new one.", err: true }, 401);
    await env.DB.prepare(`UPDATE auth_tokens SET attempts = attempts + 1 WHERE id=?`).bind(tok.id).run();
    if (!/^\d{6}$/.test(code) || !safeEqual(await sha256(`code:${email}:${code}`), tok.token_hash)) {
      return codeEntryPage(c, email, { msg: `That code isn't right. ${MAX_CODE_ATTEMPTS - tok.attempts - 1} tries left.`, err: true }, 401);
    }
    await env.DB.prepare(`UPDATE auth_tokens SET used_at = datetime('now') WHERE id=?`).bind(tok.id).run();
    let u = await userByEmail(env, email);
    if (!u) {
      if (!bootstrapEmails(env).includes(email)) return codeEntryPage(c, email, { msg: "That account no longer exists.", err: true }, 401);
      const row = await env.DB.prepare(`INSERT INTO users (email, role) VALUES (?, 'owner') RETURNING id`).bind(email).first<{ id: number }>();
      u = { id: row!.id, email, name: "", role: "owner", password_hash: null };
    }
    return startSession(env, req, u.id, u.password_hash ? url.searchParams.get("next") ?? "/" : "/account?m=Signed+in.+Set+a+password+here+if+you+want+one.");
  }

  if (p === "/forgot" && !post) return forgotPage(c);
  if (p === "/forgot" && post) {
    const email = normEmail((await req.formData()).get("email"));
    if (!mailEnabled(env)) return forgotPage(c, { msg: "Email isn't set up yet, so reset links can't be sent. Ask the Sprigboard owner to reset it.", err: true });
    if (validEmail(email) && (await rateLimit(env, `ip:forgot:${ip}`, 20, 3600)) && (await rateLimit(env, `forgot:${email}`, 3, 3600))) {
      const u = await userByEmail(env, email);
      if (u) {
        const link = `${appUrl(env, url)}/reset?t=${await issueToken(env, "reset", email, u.id, RESET_MINUTES)}`;
        await sendMail(env, {
          to: email, subject: "Reset your Sprigboard password",
          text: `Choose a new Sprigboard password here (the link works for ${RESET_MINUTES} minutes):\n${link}\n\nIf you didn't ask for this, you can ignore this email.`,
          html: emailHtml("Reset your password", `<p>The link works for ${RESET_MINUTES} minutes and can be used once.</p>`, { href: link, label: "Choose a new password" }),
        });
      }
    }
    return redirect("/login", "If that email has an account, a reset link is on its way.");
  }

  if (p === "/reset" && !post) {
    const link = url.searchParams.get("t") ?? "";
    const tok = await findLink(env, link);
    if (!tok) return authPage("Link expired", `<h1>That link has expired</h1><p class="sub">Reset links work once, for ${RESET_MINUTES} minutes. Invite links work for ${INVITE_DAYS} days.</p><div class="alt"><a href="/forgot">Send a new reset link</a><a href="/login">Back to sign in</a></div>`, null, 410);
    return resetPage(c, link, tok.purpose === "invite", tok.email);
  }
  if (p === "/reset" && post) {
    const f = await req.formData();
    const link = String(f.get("t") ?? "");
    const tok = await findLink(env, link);
    if (!tok || !tok.user_id) return redirect("/forgot", "That link has expired. Ask for a new one.", true);
    const pw = String(f.get("password") ?? "");
    const problem = passwordProblem(pw, String(f.get("confirm") ?? ""), tok.email);
    if (problem) return resetPage(c, link, tok.purpose === "invite", tok.email, { msg: problem, err: true }, 400);
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=? AND deleted_at IS NULL`).bind(await hashPassword(pw, iterationsFor(env)), tok.user_id),
      env.DB.prepare(`UPDATE auth_tokens SET used_at = datetime('now') WHERE id=?`).bind(tok.id),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(tok.user_id), // sign out everywhere else
    ]);
    return startSession(env, req, tok.user_id, "/?m=Password+saved.+You%27re+signed+in.");
  }

  if (p === "/logout" && post) {
    await endSession(env, req);
    return new Response(null, { status: 303, headers: { location: "/login?m=Signed+out.", "set-cookie": cookie(req, "", 0) } });
  }
  return null;
}

// ---------- signed-in pages: account and users ----------

type AppCtx = AuthCtx & { user: User };

export async function accountPage(c: AppCtx): Promise<Response> {
  const u = c.user;
  const sessions = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND expires_at > datetime('now')`).bind(u.id).first<{ n: number }>();
  const passkeys = await listPasskeys(c.env, u.id);
  const pkIds = new Map(passkeys.map((k, i) => [k.id, i])); // short ids for dialog elements
  const body = `<h1>Your account</h1><p class="sub">${esc(u.email)} · ${u.role === "owner" ? "Owner" : "Member"}</p>
    <form method="post" action="/account/name" class="panel"><div class="grid">
      ${field("name", "Your name", u.name, { full: true, attrs: 'autocomplete="name"' })}</div>
      <div class="btns"><button class="btn btn-primary">Save name</button></div></form>
    <h2>${u.has_password ? "Change password" : "Set a password"}</h2>
    <form method="post" action="/account/password" class="panel">
      <input type="text" name="username" value="${esc(u.email)}" autocomplete="username" hidden><div class="grid">
      ${u.has_password ? field("current", "Current password", "", { type: "password", required: true, full: true, attrs: 'autocomplete="current-password"' }) : `<p class="small muted full">You signed in with a code. A password lets you sign in without waiting for an email.</p>`}
      ${field("password", "New password", "", { type: "password", required: true, hint: `At least ${MIN_PASSWORD} characters.`, attrs: `autocomplete="new-password" minlength="${MIN_PASSWORD}"` })}
      ${field("confirm", "Type it again", "", { type: "password", required: true, attrs: 'autocomplete="new-password"' })}</div>
      <div class="btns"><button class="btn btn-primary">${u.has_password ? "Change password" : "Set password"}</button></div></form>
    <div class="bar"><h2>Passkeys</h2><span data-passkey hidden>${iconBtn({ icon: "key", label: "Add a passkey", dialog: "passkey-add" })}</span></div>
    <p class="sub small">Sign in with your fingerprint, face or device PIN instead of a password. Passkeys sync through iCloud Keychain, Google Password Manager and similar.
      <span data-passkey-unsupported hidden><b>This browser can't create passkeys.</b></span></p>
    ${table(["Name", "Added", "Last used", "Synced", "Actions"], passkeys.map((k) => [
      esc(k.name), esc(String(k.created_at).slice(0, 10)), k.last_used_at ? esc(String(k.last_used_at).slice(0, 16)) : '<span class="muted">Never</span>',
      k.backed_up ? badge("Synced", "ok") : badge("This device", "muted"),
      iconBtn({ icon: "pencil", label: `Rename ${String(k.name)}`, dialog: `pk-edit-${pkIds.get(k.id)}` }) + iconBtn({ icon: "bin", label: `Remove ${String(k.name)}`, dialog: `pk-del-${pkIds.get(k.id)}`, danger: true }),
    ]), "No passkeys yet. Add one to sign in without a password.")}
    ${passkeys.map((k) => formDialog(`pk-edit-${pkIds.get(k.id)}`, "Rename passkey", `/passkeys/${String(k.id)}`, field("name", "Name", String(k.name), { required: true, full: true })) +
      confirmDelete(`pk-del-${pkIds.get(k.id)}`, `the passkey "${String(k.name)}"`, `/passkeys/${String(k.id)}/delete`)).join("")}
    ${dialog("passkey-add", "Add a passkey", `<form id="passkey-add-form"><div class="grid">${field("name", "Name", deviceName(c.req.headers.get("user-agent") ?? ""), { required: true, full: true, hint: "So you can tell your passkeys apart, e.g. Jamie's iPhone." })}</div>
      <div id="passkey-add-msg" role="status" hidden></div>
      <div class="btns"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Create passkey</button></div></form>`)}
    <h2>Sign-ins</h2>
    <div class="panel bar"><span class="grow">Signed in on ${sessions?.n ?? 1} browser${(sessions?.n ?? 1) === 1 ? "" : "s"}.</span>
      ${iconBtn({ icon: "power", label: "Sign out of every browser", dialog: "out-all", danger: true })}</div>
    ${dialog("out-all", "Sign out everywhere?", `<form method="post" action="/account/signout-all"><p>This signs you out of every browser, including this one.</p>
      <div class="btns"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-danger">Sign out everywhere</button></div></form>`, { danger: true })}`;
  return layout({ title: "Your account", path: c.url.pathname, user: u, body, flash: flashOf(c.url), script: PASSKEY_JS });
}

export async function accountPost(c: AppCtx): Promise<Response | null> {
  const { env, req, url, user } = c;
  if (url.pathname === "/account/name") {
    const name = String((await req.formData()).get("name") ?? "").trim().slice(0, 100);
    await env.DB.prepare(`UPDATE users SET name=? WHERE id=?`).bind(name, user.id).run();
    return redirect("/account", "Name saved.");
  }
  if (url.pathname === "/account/password") {
    const f = await req.formData();
    const pw = String(f.get("password") ?? "");
    if (user.has_password) {
      if (!(await rateLimit(env, `pwchange:${user.id}`, 8, 900))) return redirect("/account", TOO_MANY, true);
      const row = await env.DB.prepare(`SELECT password_hash FROM users WHERE id=?`).bind(user.id).first<{ password_hash: string }>();
      if (!row?.password_hash || !(await verifyPassword(String(f.get("current") ?? ""), row.password_hash)).ok) return redirect("/account", "Your current password isn't right.", true);
    }
    const problem = passwordProblem(pw, String(f.get("confirm") ?? ""), user.email);
    if (problem) return redirect("/account", problem, true);
    const token = readCookie(req, SESSION_COOKIE) ?? "";
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET password_hash=? WHERE id=?`).bind(await hashPassword(pw, iterationsFor(env)), user.id),
      // Keep this browser signed in; sign out the others.
      env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND token_hash <> ?`).bind(user.id, await sha256(token)),
    ]);
    return redirect("/account", "Password saved. Other browsers have been signed out.");
  }
  if (url.pathname === "/account/signout-all") {
    await env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(user.id).run();
    return new Response(null, { status: 303, headers: { location: "/login?m=Signed+out+everywhere.", "set-cookie": cookie(req, "", 0) } });
  }
  return null;
}

export async function usersPage(c: AppCtx, inviteLink?: { email: string; link: string }): Promise<Response> {
  const { results } = await c.env.DB.prepare(`SELECT id, email, name, role, password_hash IS NOT NULL AS has_password, last_login_at, (SELECT COUNT(*) FROM passkeys k WHERE k.user_id = users.id) AS passkeys FROM users WHERE deleted_at IS NULL ORDER BY role DESC, email`).all<Record<string, unknown>>();
  const rows = results.map((u) => {
    const self = Number(u.id) === c.user.id;
    return [
      `${esc(u.name) || '<span class="muted">No name yet</span>'}${self ? ` ${badge("You", "muted")}` : ""}`,
      esc(u.email),
      u.role === "owner" ? badge("Owner", "ok") : badge("Member"),
      (u.has_password ? badge("Password", "ok") : badge("No password", "warn")) + (Number(u.passkeys) ? ` ${badge(`${u.passkeys} passkey${Number(u.passkeys) === 1 ? "" : "s"}`, "ok")}` : ""),
      u.last_login_at ? esc(String(u.last_login_at).slice(0, 16)) : '<span class="muted">Never</span>',
      (u.has_password || Number(u.passkeys) ? "" : `<form method="post" action="/users/${u.id}/invite">${iconBtn({ icon: "mail", label: `Send ${String(u.email)} a new invite link` })}</form>`) +
        (self ? "" : iconBtn({ icon: "pencil", label: `Change role for ${String(u.email)}`, dialog: `role-${u.id}` }) +
          iconBtn({ icon: "bin", label: `Remove ${String(u.email)}`, dialog: `del-user-${u.id}`, danger: true })),
    ];
  });
  const dlgs = results.filter((u) => Number(u.id) !== c.user.id).map((u) =>
    formDialog(`role-${u.id}`, `Role for ${esc(u.email)}`, `/users/${u.id}`, pills("role", "Role", [["member", "Member"], ["owner", "Owner"]], String(u.role)) + `<p class="small muted full">Owners can also manage users.</p>`) +
    confirmDelete(`del-user-${u.id}`, String(u.email), `/users/${u.id}/delete`)).join("");
  const mail = mailEnabled(c.env);
  const body = `<div class="bar"><h1>Users</h1>${iconBtn({ icon: "plus", label: "Invite someone", dialog: "invite" }).replace('class="ib"', 'class="ib primary"')}</div>
    <p class="sub">Who can sign in to Sprigboard. Invited people get an email with a link to choose their password; they can also sign in with an emailed code.</p>
    ${inviteLink ? `<div class="flash" role="status">Email isn't set up, so send this invite link to ${esc(inviteLink.email)} yourself (it works for ${INVITE_DAYS} days):<br><input readonly value="${esc(inviteLink.link)}" onclick="this.select()" style="margin-top:6px"></div>` : ""}
    ${table(["Name", "Email", "Role", "Sign-in", "Last sign-in", "Actions"], rows, "No users.")}
    ${formDialog("invite", "Invite someone", "/users", `${field("email", "Email", "", { type: "email", required: true, full: true })}${field("name", "Name", "", { full: true })}
      ${pills("role", "Role", [["member", "Member"], ["owner", "Owner"]], "member")}
      <p class="small muted full">${mail ? "They'll get an email with a link to choose a password." : "Email isn't set up, so you'll get a link to send them yourself."}</p>`, "Invite")}${dlgs}`;
  return layout({ title: "Users", path: "/users", user: c.user, body, flash: flashOf(c.url) });
}

async function sendInvite(c: AppCtx, userId: number, email: string): Promise<{ sent: boolean; link: string }> {
  const link = `${appUrl(c.env, c.url)}/reset?t=${await issueToken(c.env, "invite", email, userId, INVITE_DAYS * 1440)}`;
  const who = c.user.name || c.user.email;
  const sent = mailEnabled(c.env) && await sendMail(c.env, {
    to: email, subject: `${who} invited you to Sprigboard`,
    text: `${who} invited you to Sprigboard. Choose your password here (the link works for ${INVITE_DAYS} days):\n${link}`,
    html: emailHtml("You're invited to Sprigboard", `<p>${esc(who)} invited you. Choose a password to get started; the link works for ${INVITE_DAYS} days.</p>`, { href: link, label: "Choose your password" }),
  });
  return { sent, link };
}

export async function usersPost(c: AppCtx): Promise<Response | null> {
  const { env, req, url, user } = c;
  if (user.role !== "owner") return new Response("Only owners can manage users.", { status: 403 });
  const p = url.pathname;
  let r: RegExpExecArray | null;
  if (p === "/users") {
    const f = await req.formData();
    const email = normEmail(f.get("email"));
    if (!validEmail(email)) return redirect("/users", "Enter a valid email address.", true);
    if (await userByEmail(env, email)) return redirect("/users", "That person already has an account.", true);
    const role = f.get("role") === "owner" ? "owner" : "member";
    const row = await env.DB.prepare(`INSERT INTO users (email, name, role) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET deleted_at=NULL, name=excluded.name, role=excluded.role, password_hash=NULL RETURNING id`)
      .bind(email, String(f.get("name") ?? "").trim().slice(0, 100), role).first<{ id: number }>();
    const inv = await sendInvite(c, row!.id, email);
    return inv.sent ? redirect("/users", `Invite sent to ${email}.`) : usersPage(c, { email, link: inv.link });
  }
  if ((r = /^\/users\/(\d+)\/invite$/.exec(p))) {
    const u = await env.DB.prepare(`SELECT id, email FROM users WHERE id=? AND deleted_at IS NULL`).bind(+r[1]).first<{ id: number; email: string }>();
    if (!u) return redirect("/users", "That user no longer exists.", true);
    const inv = await sendInvite(c, u.id, u.email);
    return inv.sent ? redirect("/users", `New invite sent to ${u.email}.`) : usersPage(c, { email: u.email, link: inv.link });
  }
  if ((r = /^\/users\/(\d+)\/delete$/.exec(p))) {
    if (+r[1] === user.id) return redirect("/users", "You can't remove yourself.", true);
    await env.DB.batch([
      env.DB.prepare(`UPDATE users SET deleted_at = datetime('now') WHERE id=?`).bind(+r[1]),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id=?`).bind(+r[1]),
      env.DB.prepare(`DELETE FROM passkeys WHERE user_id=?`).bind(+r[1]),
      env.DB.prepare(`UPDATE auth_tokens SET used_at = datetime('now') WHERE user_id=? AND used_at IS NULL`).bind(+r[1]),
    ]);
    return redirect("/users", "User removed and signed out.");
  }
  if ((r = /^\/users\/(\d+)$/.exec(p))) {
    if (+r[1] === user.id) return redirect("/users", "Ask another owner to change your role.", true);
    const role = (await req.formData()).get("role") === "owner" ? "owner" : "member";
    await env.DB.prepare(`UPDATE users SET role=? WHERE id=? AND deleted_at IS NULL`).bind(role, +r[1]).run();
    return redirect("/users", "Role saved.");
  }
  return null;
}
