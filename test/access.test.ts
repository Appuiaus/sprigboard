import { describe, expect, it } from "vitest";
import { verifyAccess } from "../src/access";

const env = { ACCESS_TEAM_DOMAIN: "team", ACCESS_AUD: "aud-1" };
const req = new Request("https://x/");
const ctxAccess = (aud: string) => ({ aud, getIdentity: async () => ({ email: "ben@example.com" }) });

describe("verifyAccess", () => {
  it("fails closed when not configured", async () => {
    expect(await verifyAccess(req, { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }, ctxAccess("aud-1"))).toMatchObject({ ok: false, status: 503 });
  });
  it("accepts Worker-level Access for our audience", async () => {
    expect(await verifyAccess(req, env, ctxAccess("aud-1"))).toEqual({ ok: true, email: "ben@example.com" });
  });
  it("rejects Worker-level Access for another application", async () => {
    expect(await verifyAccess(req, env, ctxAccess("other"))).toMatchObject({ ok: false, status: 403 });
  });
  it("rejects requests with neither ctx.access nor a JWT", async () => {
    expect(await verifyAccess(req, env)).toMatchObject({ ok: false, status: 403, reason: "Missing Access token." });
  });
  it("rejects a malformed JWT", async () => {
    const r = new Request("https://x/", { headers: { "Cf-Access-Jwt-Assertion": "aaa.bbb.ccc" } });
    expect(await verifyAccess(r, env)).toMatchObject({ ok: false, status: 403 });
  });
});
