import { describe, expect, it } from "vitest";
import { hashPassword, normEmail, passwordProblem, randomCode, randomToken, safeEqual, safeNext, sha256, verifyPassword } from "../src/auth";
import { mailEnabled, parseFrom, sendMail } from "../src/mail";

describe("passwords", () => {
  it("hashes with a salt and verifies", async () => {
    const a = await hashPassword("a long garden path", 10_000);
    const b = await hashPassword("a long garden path", 10_000);
    expect(a).toMatch(/^pbkdf2-sha256\$10000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword("a long garden path", a, 10_000)).toEqual({ ok: true, rehash: false });
    expect((await verifyPassword("a long garden patH", a, 10_000)).ok).toBe(false);
  });
  it("asks for a rehash when the iteration setting changes", async () => {
    const a = await hashPassword("a long garden path", 10_000);
    expect(await verifyPassword("a long garden path", a, 20_000)).toEqual({ ok: true, rehash: true });
  });
  it("rejects malformed hashes", async () => {
    expect((await verifyPassword("x", "plain-text")).ok).toBe(false);
  });
  it("matches the CLI tool's format (100000 iterations)", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h.split("$")[1]).toBe("100000");
  });
  it("explains weak passwords", () => {
    expect(passwordProblem("short", "short")).toMatch(/at least 10/);
    expect(passwordProblem("long enough pw", "long enough pW")).toMatch(/don't match/);
    expect(passwordProblem("aaaaaaaaaaaa", "aaaaaaaaaaaa")).toMatch(/easy/);
    expect(passwordProblem("jamie-garden-2026", "jamie-garden-2026", "jamie@example.com")).toMatch(/email name/);
    expect(passwordProblem("lemon myrtle by the gate", "lemon myrtle by the gate", "jamie@example.com")).toBeNull();
  });
});

describe("tokens", () => {
  it("makes 6-digit codes", () => {
    for (let i = 0; i < 200; i++) expect(randomCode()).toMatch(/^\d{6}$/);
  });
  it("makes url-safe random tokens", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });
  it("hashes and compares", async () => {
    expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ab")).toBe(false);
  });
  it("only redirects within the site", () => {
    expect(safeNext("/jobs/1")).toBe("/jobs/1");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext(null)).toBe("/");
  });
  it("normalises emails", () => expect(normEmail("  Jamie@Example.COM ")).toBe("jamie@example.com"));
});

describe("mail", () => {
  it("parses the sender", () => {
    expect(parseFrom("Sprigboard <noreply@velosolabs.com>")).toEqual({ Email: "noreply@velosolabs.com", Name: "Sprigboard" });
    expect(parseFrom("noreply@velosolabs.com")).toEqual({ Email: "noreply@velosolabs.com" });
  });
  it("is off until configured", async () => {
    expect(mailEnabled({})).toBe(false);
    expect(await sendMail({}, { to: "a@b.co", subject: "s", text: "t", html: "h" })).toBe(false);
    expect(mailEnabled({ MAIL_MODE: "log" })).toBe(true);
  });
  it("posts to Mailjet's send API", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, init }; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const env = { MAILJET_API_KEY: "k", MAILJET_API_SECRET: "s", MAIL_FROM: "Sprigboard <noreply@velosolabs.com>" };
    expect(await sendMail(env, { to: "jamie@example.com", subject: "Hi", text: "t", html: "<p>h</p>" }, f)).toBe(true);
    expect(seen!.url).toBe("https://api.mailjet.com/v3.1/send");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe(`Basic ${btoa("k:s")}`);
    const body = JSON.parse(String(seen!.init.body));
    expect(body.Messages[0]).toMatchObject({ From: { Email: "noreply@velosolabs.com", Name: "Sprigboard" }, To: [{ Email: "jamie@example.com" }], Subject: "Hi" });
  });
  it("reports a failed send without throwing", async () => {
    const f = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    expect(await sendMail({ MAILJET_API_KEY: "k", MAILJET_API_SECRET: "s", MAIL_FROM: "a@b.co" }, { to: "x@y.co", subject: "s", text: "t", html: "h" }, f)).toBe(false);
  });
});
