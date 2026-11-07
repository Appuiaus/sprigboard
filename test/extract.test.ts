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
  it("sends PDFs as file documents", () => {
    expect(planBlock("application/pdf", "file_1")).toEqual({ type: "document", source: { type: "file", file_id: "file_1" } });
  });
  it("sends images as file images", () => {
    expect(planBlock("image/jpeg", "file_2")).toEqual({ type: "image", source: { type: "file", file_id: "file_2" } });
  });
  it("rejects other files", () => {
    expect(isSupportedPlan("image/svg+xml")).toBe(false);
    expect(() => planBlock("image/svg+xml", "f")).toThrow();
  });
});

import { extractPlan, ExtractionError } from "../src/extract";

function sse(events: [string, unknown][]): Response {
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function fakeClaude(text: string, stopReason = "end_turn") {
  const calls: { url: string; headers: Headers; body: any }[] = [];
  const uploads: { url: string; size: number }[] = [];
  const deleted: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as any, init);
    if (req.url.includes("/v1/files") && req.method === "POST") {
      uploads.push({ url: req.url, size: (await req.arrayBuffer()).byteLength });
      return new Response(JSON.stringify({ id: "file_abc", type: "file", filename: "plan.pdf", mime_type: "application/pdf", size_bytes: 8, created_at: "2026-11-07T00:00:00Z" }), { headers: { "content-type": "application/json" } });
    }
    if (req.url.includes("/v1/files/") && req.method === "DELETE") {
      deleted.push(req.url);
      return new Response(JSON.stringify({ id: "file_abc", type: "file_deleted" }), { headers: { "content-type": "application/json" } });
    }
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
  return { f, calls, uploads, deleted };
}

describe("extractPlan (fake API)", () => {
  const pdf = { mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4").buffer as ArrayBuffer };
  const answer = JSON.stringify({ items: [{ kind: "plant", label: "Westringia fruticosa", detail: "", quantity: "8" }], scale: "1:100", site_address: "", summary: "Back yard" });

  it("sends the plan with the schema, model and fallback beta, and parses the answer", async () => {
    const { f, calls, uploads, deleted } = fakeClaude(answer);
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
    expect(c.body.messages[0].content[0]).toEqual({ type: "document", source: { type: "file", file_id: "file_abc" } });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].size).toBeGreaterThan(8); // multipart body containing the file
    expect(deleted).toEqual([expect.stringContaining("/v1/files/file_abc")]);
    expect(c.body.thinking).toBeUndefined();
  });

  it("reports a refusal plainly and still deletes the upload", async () => {
    const { f, deleted } = fakeClaude("", "refusal");
    await expect(extractPlan("sk-test", pdf, "plan.pdf", f)).rejects.toBeInstanceOf(ExtractionError);
    expect(deleted).toHaveLength(1);
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
