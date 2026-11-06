import { describe, expect, it } from "vitest";
import { isSupportedPlan, parseExtraction, planBlock } from "../src/extract";

describe("parseExtraction", () => {
  it("keeps valid items and cleans the rest", () => {
    const out = parseExtraction(JSON.stringify({
      items: [
        { kind: "plant", label: " Lomandra 'Tanika' ", detail: "140mm", quantity: "12" },
        { kind: "weird", label: "North point", detail: "", quantity: "" },
        { kind: "street", label: "", detail: "", quantity: "" },
        null,
      ],
      scale: "1:200", site_address: "1 Main St", summary: "Front garden",
    }));
    expect(out.items).toEqual([
      { kind: "plant", label: "Lomandra 'Tanika'", detail: "140mm", quantity: "12" },
      { kind: "note", label: "North point", detail: "", quantity: "" },
    ]);
    expect(out.scale).toBe("1:200");
  });
  it("throws on non-JSON", () => expect(() => parseExtraction("nope")).toThrow());
});

describe("planBlock", () => {
  const bytes = new TextEncoder().encode("hello").buffer as ArrayBuffer;
  it("sends PDFs as documents", () => {
    expect(planBlock({ mime: "application/pdf", bytes })).toMatchObject({ type: "document", source: { media_type: "application/pdf", data: "aGVsbG8=" } });
  });
  it("sends images as images", () => {
    expect(planBlock({ mime: "image/jpeg", bytes })).toMatchObject({ type: "image", source: { media_type: "image/jpeg" } });
  });
  it("rejects other files", () => {
    expect(isSupportedPlan("image/svg+xml")).toBe(false);
    expect(() => planBlock({ mime: "image/svg+xml", bytes })).toThrow();
  });
});

import { extractPlan, ExtractionError } from "../src/extract";

function sse(events: [string, unknown][]): Response {
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function fakeClaude(text: string, stopReason = "end_turn") {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    calls.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) });
    return sse([
      ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 20) } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(20) } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 50 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
  }) as typeof fetch;
  return { f, calls };
}

describe("extractPlan (fake API)", () => {
  const pdf = { mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4").buffer as ArrayBuffer };
  const answer = JSON.stringify({ items: [{ kind: "plant", label: "Westringia fruticosa", detail: "", quantity: "8" }], scale: "1:100", site_address: "", summary: "Back yard" });

  it("sends the plan with the schema, model and fallback beta, and parses the answer", async () => {
    const { f, calls } = fakeClaude(answer);
    const out = await extractPlan("sk-test", pdf, "plan.pdf", f);
    expect(out.items).toEqual([{ kind: "plant", label: "Westringia fruticosa", detail: "", quantity: "8" }]);
    expect(out.scale).toBe("1:100");
    const c = calls[0];
    expect(c.url).toContain("/v1/messages");
    expect(c.headers.get("x-api-key") ?? c.headers.get("authorization")).toMatch(/sk-test/);
    expect(c.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(c.body.model).toBe("claude-opus-5-5");
    expect(c.body.stream).toBe(true);
    expect(c.body.fallbacks).toBe("default");
    expect(c.body.output_config.format.type).toBe("json_schema");
    expect(c.body.messages[0].content[0]).toMatchObject({ type: "document", source: { media_type: "application/pdf" } });
    expect(c.body.thinking).toBeUndefined();
  });

  it("reports a refusal plainly", async () => {
    const { f } = fakeClaude("", "refusal");
    await expect(extractPlan("sk-test", pdf, "plan.pdf", f)).rejects.toBeInstanceOf(ExtractionError);
  });

  it("reports an unreadable answer plainly", async () => {
    const { f } = fakeClaude("not json at all, sorry");
    await expect(extractPlan("sk-test", pdf, "plan.pdf", f)).rejects.toThrow("couldn't be read");
  });

  it("maps a bad key to a clear message", async () => {
    const f = (async () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "bad key" } }), { status: 401, headers: { "content-type": "application/json" } })) as typeof fetch;
    await expect(extractPlan("sk-bad", pdf, "plan.pdf", f)).rejects.toThrow("API key");
  });
});
