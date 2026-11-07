import { describe, expect, it } from "vitest";
import { csvTable, detectKind, inlineMime, looksLikePdf, textBlock, viewerContent } from "../src/viewer";

const enc = (s: string) => new TextEncoder().encode(s);

describe("detectKind", () => {
  it("tells PDF-compatible Illustrator files from legacy ones", () => {
    expect(detectKind("plan.ai", "application/postscript", enc("%PDF-1.6\n%âãÏÓ"))).toBe("ai-pdf");
    expect(detectKind("plan.ai", "", enc("%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator"))).toBe("ai-legacy");
    expect(detectKind("plan.AI", "application/illustrator")).toBe("ai-legacy");
    expect(detectKind("art.eps", "application/postscript", enc("%!PS-Adobe-3.0 EPSF-3.0"))).toBe("eps");
  });
  it("recognises common types", () => {
    expect(detectKind("a.pdf", "application/pdf")).toBe("pdf");
    expect(detectKind("a.svg", "image/svg+xml")).toBe("image");
    expect(detectKind("photo.JPG", "")).toBe("image");
    expect(detectKind("x.csv", "text/csv; charset=utf-8")).toBe("csv");
    expect(detectKind("tb.xml", "application/xml; charset=utf-8")).toBe("text");
    expect(detectKind("data.json", "application/json")).toBe("text");
    expect(detectKind("clip.mp4", "video/mp4")).toBe("video");
    expect(detectKind("note.m4a", "")).toBe("audio");
    expect(detectKind("quote.docx", "")).toBe("office");
    expect(detectKind("thing.dwg", "")).toBe("other");
  });
  it("finds the PDF marker within the first KB", () => {
    expect(looksLikePdf(enc("junk\n%PDF-1.4"))).toBe(true);
    expect(looksLikePdf(enc("%!PS"))).toBe(false);
  });
});

describe("rendering", () => {
  it("serves a PDF-compatible .ai as a PDF", () => {
    expect(inlineMime("ai-pdf", "application/postscript", "plan.ai")).toBe("application/pdf");
    expect(inlineMime("image", "", "a.svg")).toBe("image/svg+xml");
  });
  it("renders CSV as an escaped table and caps rows", () => {
    const html = csvTable("a,b\n<x>,2\n3,4\n", 1);
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("&lt;x&gt;");
    expect(html).toContain("first 1 of 2 rows");
  });
  it("pretty-prints JSON and escapes text", () => {
    expect(textBlock('{"a":1}')).toContain('{\n  &quot;a&quot;: 1\n}');
    expect(textBlock("<script>")).toContain("&lt;script&gt;");
  });
  it("offers a download when there's no preview", () => {
    const html = viewerContent({ name: "old.ai", kind: "ai-legacy", downloadUrl: "/d", size: 2048 });
    expect(html).toContain("PDF Compatible");
    expect(html).toContain('href="/d"');
  });
});
