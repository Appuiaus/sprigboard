#!/usr/bin/env node
// Creates (or resets) a Sprigboard user with a password, without email.
// Use it for the first owner, or to rescue an account before email is set up.
//
//   node tools/create-user.mjs jamie@example.com "Jamie" owner --remote
//   node tools/create-user.mjs jamie@example.com "Jamie" owner --local
//
// It asks for the password (hidden) and runs `wrangler d1 execute` with the hashed value,
// so the password never appears in the command line or the shell history.
import { execFileSync } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import readline from "node:readline";

const [email, name = "", role = "owner", where = "--local"] = process.argv.slice(2);
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !["owner", "member"].includes(role) || !["--local", "--remote"].includes(where)) {
  console.error('Usage: node tools/create-user.mjs <email> "<name>" <owner|member> <--local|--remote>');
  process.exit(1);
}

function askHidden(q) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(q)) rl.output.write(s); };
    rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); resolve(a); });
  });
}

const pw = process.env.SPRIGBOARD_PASSWORD ?? (await askHidden("Password (at least 10 characters): "));
if (pw.length < 10) { console.error("Use at least 10 characters."); process.exit(1); }
if (!process.env.SPRIGBOARD_PASSWORD && pw !== (await askHidden("Type it again: "))) { console.error("The passwords don't match."); process.exit(1); }

// Same format as src/auth.ts hashPassword().
const iterations = 100000;
const salt = crypto.getRandomValues(new Uint8Array(16));
const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw.normalize("NFKC")), "PBKDF2", false, ["deriveBits"]);
const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
const b64 = (u) => Buffer.from(u).toString("base64");
const hash = `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(bits)}`;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const sql = `INSERT INTO users (email, name, role, password_hash) VALUES (${q(email.toLowerCase())}, ${q(name)}, ${q(role)}, ${q(hash)})
ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role, password_hash=excluded.password_hash, deleted_at=NULL;`;
execFileSync("npx", ["wrangler", "d1", "execute", "sprigboard-db", where, "--command", sql], { stdio: ["ignore", "ignore", "inherit"] });
console.log(`${email} can now sign in (${where.slice(2)}).`);
