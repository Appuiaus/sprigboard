import { describe, expect, it } from "vitest";
import {
  addDays, continueFrom, formatDollars, formatNumber, invoiceTotals, matchSymbol, normalisePlant, parseDollars,
  titleBlockCsv, titleBlockXml, toCsv, todayBrisbane, type TitleBlock,
} from "../src/lib";
import { parseLines } from "../src/index";

describe("numbering", () => {
  it("pads", () => {
    expect(formatNumber("J-", 7)).toBe("J-0007");
    expect(formatNumber("INV", 12345, 4)).toBe("INV12345");
  });
  it("carries on from the last paper invoice", () => {
    expect(continueFrom("INV-0042")).toEqual({ prefix: "INV-", next: 43, pad: 4 });
    expect(continueFrom("2026/19")).toEqual({ prefix: "2026/", next: 20, pad: 2 });
    expect(continueFrom("118")).toEqual({ prefix: "", next: 119, pad: 3 });
    expect(continueFrom("ABC")).toBeNull();
  });
});

describe("money", () => {
  it("parses dollars into cents", () => {
    expect(parseDollars("250")).toBe(25000);
    expect(parseDollars("$1,250.5")).toBe(125050);
    expect(parseDollars("0.05")).toBe(5);
    expect(parseDollars("12.345")).toBeNull();
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("-5")).toBeNull();
  });
  it("formats cents", () => {
    expect(formatDollars(125050)).toBe("$1,250.50");
    expect(formatDollars(5)).toBe("$0.05");
  });
  it("adds GST only when registered", () => {
    const lines = [{ description: "Drawing", qty: 1, unit_cents: 33333 }];
    expect(invoiceTotals(lines, false)).toEqual({ subtotal_cents: 33333, gst_cents: 0, total_cents: 33333 });
    expect(invoiceTotals(lines, true)).toEqual({ subtotal_cents: 33333, gst_cents: 3333, total_cents: 36666 });
  });
  it("parses invoice lines", () => {
    expect(parseLines("Drawing | 250\nRevision | 40.00 | 2")).toEqual([
      { description: "Drawing", qty: 1, unit_cents: 25000 },
      { description: "Revision", qty: 2, unit_cents: 4000 },
    ]);
    expect(parseLines("Drawing")).toBeNull();
    expect(parseLines("")).toBeNull();
    expect(parseLines("Drawing | 10 | 0")).toBeNull();
  });
});

describe("dates", () => {
  it("adds days across months", () => expect(addDays("2026-11-20", 14)).toBe("2026-12-04"));
  it("uses Brisbane's date", () => expect(todayBrisbane(new Date("2026-11-06T15:30:00Z"))).toBe("2026-11-07"));
});

describe("csv", () => {
  it("quotes when needed", () => expect(toCsv([["a", 'b "c"', "d,e"], [1, null, "x\ny"]])).toBe('a,"b ""c""","d,e"\r\n1,,"x\ny"\r\n'));
});

const tb: TitleBlock = {
  job_number: "J-0001", project: "Smith & Co <garden>", client: "Shane's Landscapes", site_address: "1 Main St",
  scale: "1:200 @ A3", date: "2026-11-06", disclaimer: "Not for construction", copyright: "© Shane", drawn_by: "Jamie",
};

describe("title block exports", () => {
  it("csv has one header and one data row", () => {
    const rows = titleBlockCsv(tb).trim().split("\r\n");
    expect(rows).toHaveLength(2);
    expect(rows[0].startsWith("job_number,project,client")).toBe(true);
  });
  it("xml escapes text and declares each variable", () => {
    const xml = titleBlockXml(tb);
    expect(xml).toContain('varName="site_address" trait="textcontent"');
    expect(xml).toContain("<p>Smith &amp; Co &lt;garden&gt;</p>");
    expect(xml).not.toContain("<garden>");
  });
});

describe("plant matching", () => {
  const syms = [
    { id: 1, botanical: "Lomandra longifolia 'Tanika'", common: "Spiny-head mat-rush", code: "LT" },
    { id: 2, botanical: "Westringia fruticosa", common: "Coastal rosemary", code: "" },
    { id: 3, botanical: "Acacia cognata 'Limelight'", common: "", code: "" },
  ];
  it("normalises names", () => expect(normalisePlant(" Lomandra  ‘Tanika’ ")).toBe("lomandra tanika"));
  it("matches by code, exact name and common name", () => {
    expect(matchSymbol("LT", syms)).toMatchObject({ symbol: { id: 1 }, how: "code" });
    expect(matchSymbol("Lomandra longifolia 'Tanika'", syms)).toMatchObject({ symbol: { id: 1 }, how: "exact" });
    expect(matchSymbol("coastal rosemary", syms)).toMatchObject({ symbol: { id: 2 }, how: "exact" });
  });
  it("falls back to species then genus", () => {
    expect(matchSymbol("Westringia fruticosa 'Grey Box'", syms)).toMatchObject({ symbol: { id: 2 }, how: "species" });
    expect(matchSymbol("Acacia fimbriata", syms)).toMatchObject({ symbol: { id: 3 }, how: "genus" });
    expect(matchSymbol("Callistemon viminalis", syms)).toBeNull();
  });
});

import { parseCsv, plantRowsFromCsv } from "../src/lib";

describe("csv import", () => {
  it("parses quotes, commas and newlines", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n\n')).toEqual([["a", "b"], ["x, y", 'say "hi"\nthere']]);
  });
  it("reads plant columns by header name", () => {
    const r = plantRowsFromCsv("Code,Botanical name,Common\nLT,Lomandra 'Tanika',Mat rush\n,,\nWF,,Coastal rosemary\n");
    expect(r).toEqual({ rows: [{ botanical: "Lomandra 'Tanika'", common: "Mat rush", code: "LT" }], skipped: 1 });
  });
  it("explains a missing header", () => {
    expect(plantRowsFromCsv("name2,common\nx,y")).toEqual({ error: expect.stringContaining("botanical") });
    expect(plantRowsFromCsv("botanical")).toEqual({ error: expect.stringContaining("header row") });
  });
});
