// Passkey sign-in (WebAuthn) using @simplewebauthn/server.
// Register: signed-in user → /passkeys/register/options → browser creates a key → /passkeys/register/verify.
// Sign in: /login/passkey/options (discoverable, no email needed) → browser signs → /login/passkey/verify.

import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { appUrl, rateLimit, randomToken, sessionCookie, type AuthEnv, type User } from "./auth";

const CHALLENGE_MINUTES = 5;
const plusSql = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const b64urlEncode = (u8: Uint8Array) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlDecode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export function relyingParty(env: AuthEnv, url: URL) {
  const origin = appUrl(env, url);
  return { origin, rpID: new URL(origin).hostname };
}

/** A friendly default name from the browser's user agent, e.g. "iPhone · Safari". */
export function deviceName(ua: string): string {
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${os} · ${br}`;
}

async function saveChallenge(env: AuthEnv, purpose: "register" | "login", challenge: string, userId: number | null): Promise<string> {
  const id = randomToken(18);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM webauthn_challenges WHERE expires_at < datetime('now')`),
    env.DB.prepare(`INSERT INTO webauthn_challenges (id, purpose, user_id, challenge, expires_at) VALUES (?,?,?,?,?)`).bind(id, purpose, userId, challenge, plusSql(CHALLENGE_MINUTES)),
  ]);
  return id;
}

/** Takes (and deletes) a challenge, so each one works once. */
async function takeChallenge(env: AuthEnv, id: string, purpose: string): Promise<{ challenge: string; user_id: number | null } | null> {
  if (!id || id.length > 64) return null;
  return env.DB.prepare(`DELETE FROM webauthn_challenges WHERE id=? AND purpose=? AND expires_at > datetime('now') RETURNING challenge, user_id`)
    .bind(id, purpose).first<{ challenge: string; user_id: number | null }>();
}

async function readJson<T>(req: Request): Promise<T | null> {
  try { return (await req.json()) as T; } catch { return null; }
}

/** Public routes: passkey sign-in. */
export async function passkeyLoginRoute(env: AuthEnv, req: Request, url: URL): Promise<Response | null> {
  if (req.method !== "POST") return null;
  const { origin, rpID } = relyingParty(env, url);
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  if (url.pathname === "/login/passkey/options") {
    if (!(await rateLimit(env, `ip:pkopt:${ip}`, 60, 900))) return json({ error: "Too many attempts. Wait a few minutes." }, 429);
    const options = await generateAuthenticationOptions({ rpID, userVerification: "preferred" });
    return json({ flow: await saveChallenge(env, "login", options.challenge, null), options });
  }
  if (url.pathname === "/login/passkey/verify") {
    if (!(await rateLimit(env, `ip:pkverify:${ip}`, 30, 900))) return json({ error: "Too many attempts. Wait a few minutes." }, 429);
    const body = await readJson<{ flow: string; response: AuthenticationResponseJSON; next?: string }>(req);
    const ch = body ? await takeChallenge(env, String(body.flow ?? ""), "login") : null;
    if (!body || !ch) return json({ error: "That sign-in took too long. Try again." }, 400);
    const pk = await env.DB.prepare(
      `SELECT p.id, p.user_id, p.public_key, p.counter, p.transports FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.id=? AND u.deleted_at IS NULL`,
    ).bind(String(body.response?.id ?? "")).first<{ id: string; user_id: number; public_key: string; counter: number; transports: string }>();
    if (!pk) return json({ error: "Sprigboard doesn't know this passkey. Sign in another way, then add it on your Account page." }, 401);
    let verified = false, newCounter = pk.counter;
    try {
      const v = await verifyAuthenticationResponse({
        response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID,
        credential: { id: pk.id, publicKey: b64urlDecode(pk.public_key), counter: pk.counter, transports: JSON.parse(pk.transports) },
        requireUserVerification: false,
      });
      verified = v.verified; newCounter = v.authenticationInfo.newCounter;
    } catch (e) {
      console.error("passkey verify failed", e);
    }
    if (!verified) return json({ error: "That passkey couldn't be checked. Try again or sign in another way." }, 401);
    await env.DB.prepare(`UPDATE passkeys SET counter=?, last_used_at=datetime('now') WHERE id=?`).bind(newCounter, pk.id).run();
    const cookie = await sessionCookie(env, req, pk.user_id);
    const next = typeof body.next === "string" && body.next.startsWith("/") && !body.next.startsWith("//") && !body.next.startsWith("/\\") ? body.next : "/";
    return json({ ok: true, next }, 200, { "set-cookie": cookie });
  }
  return null;
}

/** Signed-in routes: add, rename and remove passkeys. */
export async function passkeyAccountRoute(env: AuthEnv, req: Request, url: URL, user: User): Promise<Response | null> {
  if (req.method !== "POST") return null;
  const { origin, rpID } = relyingParty(env, url);
  const p = url.pathname;
  let r: RegExpExecArray | null;
  if (p === "/passkeys/register/options") {
    const existing = (await env.DB.prepare(`SELECT id, transports FROM passkeys WHERE user_id=?`).bind(user.id).all<{ id: string; transports: string }>()).results;
    const options = await generateRegistrationOptions({
      rpName: "Sprigboard", rpID, userName: user.email, userDisplayName: user.name || user.email,
      userID: new Uint8Array(new TextEncoder().encode(`sprigboard-user-${user.id}`)),
      attestationType: "none",
      excludeCredentials: existing.map((e) => ({ id: e.id, transports: JSON.parse(e.transports) })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    return json({ flow: await saveChallenge(env, "register", options.challenge, user.id), options });
  }
  if (p === "/passkeys/register/verify") {
    const body = await readJson<{ flow: string; response: RegistrationResponseJSON; name?: string }>(req);
    const ch = body ? await takeChallenge(env, String(body.flow ?? ""), "register") : null;
    if (!body || !ch || ch.user_id !== user.id) return json({ error: "That took too long. Try adding the passkey again." }, 400);
    try {
      const v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: ch.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: false });
      if (!v.verified) return json({ error: "The passkey couldn't be checked. Try again." }, 400);
      const cred = v.registrationInfo.credential;
      const name = String(body.name ?? "").trim().slice(0, 60) || deviceName(req.headers.get("user-agent") ?? "");
      await env.DB.prepare(`INSERT INTO passkeys (id, user_id, public_key, counter, transports, backed_up, name) VALUES (?,?,?,?,?,?,?)`)
        .bind(cred.id, user.id, b64urlEncode(cred.publicKey), cred.counter, JSON.stringify(cred.transports ?? []), v.registrationInfo.credentialBackedUp ? 1 : 0, name).run();
      return json({ ok: true, name });
    } catch (e) {
      console.error("passkey register failed", e);
      return json({ error: "The passkey couldn't be saved. Try again." }, 400);
    }
  }
  if ((r = /^\/passkeys\/([\w-]{1,512})\/delete$/.exec(p))) {
    await env.DB.prepare(`DELETE FROM passkeys WHERE id=? AND user_id=?`).bind(r[1], user.id).run();
    return redirect("/account", "Passkey removed.");
  }
  if ((r = /^\/passkeys\/([\w-]{1,512})$/.exec(p))) {
    const name = String((await req.formData()).get("name") ?? "").trim().slice(0, 60);
    if (!name) return redirect("/account", "Give the passkey a name.", true);
    await env.DB.prepare(`UPDATE passkeys SET name=? WHERE id=? AND user_id=?`).bind(name, r[1], user.id).run();
    return redirect("/account", "Passkey renamed.");
  }
  return null;
}

const redirect = (to: string, msg: string, err = false) =>
  new Response(null, { status: 303, headers: { location: `${to}?m=${encodeURIComponent(msg)}${err ? "&e=1" : ""}` } });

export async function listPasskeys(env: AuthEnv, userId: number) {
  return (await env.DB.prepare(`SELECT id, name, backed_up, created_at, last_used_at FROM passkeys WHERE user_id=? ORDER BY created_at`).bind(userId).all<Record<string, unknown>>()).results;
}

/**
 * Browser half. Converts the JSON options to the binary form navigator.credentials needs and the
 * result back to JSON. Hand-written (no library), so it also works where
 * PublicKeyCredential.parse*FromJSON isn't available yet.
 */
export const PASSKEY_JS = `
(function(){
 if(!window.PublicKeyCredential){document.querySelectorAll("[data-passkey]").forEach(function(e){e.hidden=true});document.querySelectorAll("[data-passkey-unsupported]").forEach(function(e){e.hidden=false});return}
 document.querySelectorAll("[data-passkey]").forEach(function(e){e.hidden=false});
 function d(s){s=s.replace(/-/g,"+").replace(/_/g,"/");while(s.length%4)s+="=";var b=atob(s),u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer}
 function e(buf){var u=new Uint8Array(buf),s="";for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}
 function post(u,b){return fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b||{}),credentials:"same-origin"}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"Something went wrong.");return j})})}
 function say(el,msg,err){if(!el)return;el.textContent=msg;el.className="flash"+(err?" err":"");el.hidden=false}
 function friendly(x){return x&&x.name==="NotAllowedError"?"Cancelled, or the passkey wasn't available. Try again or sign in another way.":x&&x.name==="InvalidStateError"?"This device already has a passkey for your account.":(x&&x.message)||"Something went wrong."}
 var login=document.getElementById("passkey-login");
 if(login)login.addEventListener("click",function(){var msg=document.getElementById("passkey-msg");login.disabled=true;
  post("/login/passkey/options").then(function(o){var p=o.options;
   var pk={challenge:d(p.challenge),rpId:p.rpId,timeout:p.timeout,userVerification:p.userVerification,allowCredentials:(p.allowCredentials||[]).map(function(c){return{type:"public-key",id:d(c.id),transports:c.transports}})};
   return navigator.credentials.get({publicKey:pk}).then(function(c){if(!c)throw new Error("No passkey was chosen.");var r=c.response;
    return post("/login/passkey/verify",{flow:o.flow,next:login.dataset.next||"/",response:{id:c.id,rawId:e(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),authenticatorAttachment:c.authenticatorAttachment||undefined,
     response:{clientDataJSON:e(r.clientDataJSON),authenticatorData:e(r.authenticatorData),signature:e(r.signature),userHandle:r.userHandle?e(r.userHandle):undefined}}})})})
  .then(function(j){location.href=j.next}).catch(function(x){say(msg,friendly(x),true);login.disabled=false})});
 var add=document.getElementById("passkey-add-form");
 if(add)add.addEventListener("submit",function(ev){ev.preventDefault();var btn=add.querySelector(".btn-primary"),msg=document.getElementById("passkey-add-msg");btn.disabled=true;
  post("/passkeys/register/options").then(function(o){var p=o.options;
   var pk={challenge:d(p.challenge),rp:p.rp,user:{id:d(p.user.id),name:p.user.name,displayName:p.user.displayName},pubKeyCredParams:p.pubKeyCredParams,timeout:p.timeout,attestation:p.attestation,authenticatorSelection:p.authenticatorSelection,
    excludeCredentials:(p.excludeCredentials||[]).map(function(c){return{type:"public-key",id:d(c.id),transports:c.transports}}),extensions:p.extensions};
   return navigator.credentials.create({publicKey:pk}).then(function(c){var r=c.response;
    return post("/passkeys/register/verify",{flow:o.flow,name:add.querySelector("[name=name]").value,response:{id:c.id,rawId:e(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),authenticatorAttachment:c.authenticatorAttachment||undefined,
     response:{clientDataJSON:e(r.clientDataJSON),attestationObject:e(r.attestationObject),transports:r.getTransports?r.getTransports():[]}}})})})
  .then(function(j){location.href="/account?m="+encodeURIComponent("Passkey \\u201c"+j.name+"\\u201d added. You can now sign in with it.")}).catch(function(x){say(msg,friendly(x),true);btn.disabled=false})});
})();`;

