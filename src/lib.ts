// Pure helpers: numbering, money, CSV, Illustrator variables, plant matching.
// No I/O here, so everything is unit-tested in test/lib.test.ts.

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- Numbering ----------

/** "J-" + 7 padded to 4 → "J-0007". */
export function formatNumber(prefix: string, n: number, pad = 4): string {
  return `${prefix}${String(Math.max(0, Math.trunc(n))).padStart(pad, "0")}`;
}

/**
 * Reads the trailing number from an existing invoice or job number, so a new
 * series carries on from Jamie's last paper invoice ("INV-0042" → prefix
 * "INV-", next 43, pad 4). Returns null when there is no trailing number.
 */
export function continueFrom(last: string): { prefix: string; next: number; pad: number } | null {
  const m = /^(.*?)(\d+)\s*$/.exec(last.trim());
  if (!m) return null;
  return { prefix: m[1], next: Number(m[2]) + 1, pad: m[2].length };
}

// ---------- Money (integer cents, AUD) ----------

export const GST_RATE = 0.1;

export function parseDollars(input: string): number | null {
  const clean = input.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [d, c = ""] = clean.split(".");
  return Number(d) * 100 + Number(c.padEnd(2, "0"));
}

export function formatDollars(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const dollars = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}

export interface InvoiceLine { description: string; qty: number; unit_cents: number }

export function invoiceTotals(lines: InvoiceLine[], gstRegistered: boolean) {
  const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * l.unit_cents), 0);
  const gst = gstRegistered ? Math.round(subtotal * GST_RATE) : 0;
  return { subtotal_cents: subtotal, gst_cents: gst, total_cents: subtotal + gst };
}

/** ISO date (YYYY-MM-DD) plus n days, in UTC. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Today's date in Brisbane (Jamie's time zone), as YYYY-MM-DD. */
export function todayBrisbane(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Brisbane" }).format(now);
}

// ---------- CSV ----------

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// ---------- Title block → Illustrator ----------

export interface TitleBlock {
  job_number: string;
  project: string;
  client: string;
  site_address: string;
  scale: string;
  date: string;
  disclaimer: string;
  copyright: string;
  drawn_by: string;
}

export const TITLE_FIELDS: (keyof TitleBlock)[] = [
  "job_number", "project", "client", "site_address", "scale", "date", "disclaimer", "copyright", "drawn_by",
];

/** One header row of variable names and one data row: Illustrator's Variables panel imports this as a data set. */
export function titleBlockCsv(tb: TitleBlock): string {
  return toCsv([TITLE_FIELDS, TITLE_FIELDS.map((k) => tb[k])]);
}

const xmlEsc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Illustrator variable library (Variables panel → Load Variable Library). Text variables only. */
export function titleBlockXml(tb: TitleBlock): string {
  const vars = TITLE_FIELDS.map((k) => `\t\t\t<variable varName="${k}" trait="textcontent" category="&ns_flows;"></variable>`).join("\n");
  const data = TITLE_FIELDS.map((k) => `\t\t\t\t<${k}>\n\t\t\t\t\t<p>${xmlEsc(tb[k])}</p>\n\t\t\t\t</${k}>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 20001102//EN" "http://www.w3.org/TR/2000/CR-SVG-20001102/DTD/svg-20001102.dtd" [
\t<!ENTITY ns_vars "http://ns.adobe.com/Variables/1.0/">
\t<!ENTITY ns_imrep "http://ns.adobe.com/ImageReplacement/1.0/">
\t<!ENTITY ns_custom "http://ns.adobe.com/GenericCustomNamespace/1.0/">
\t<!ENTITY ns_flows "http://ns.adobe.com/Flows/1.0/">
\t<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">
]>
<svg>
<variableSets xmlns="&ns_vars;">
\t<variableSet varSetName="binding1" locked="none">
\t\t<variables>
${vars}
\t\t</variables>
\t\t<v:sampleDataSets xmlns:v="http://ns.adobe.com/Variables/1.0/" xmlns="&ns_custom;">
\t\t\t<v:sampleDataSet dataSetName="${xmlEsc(tb.job_number || "Job")}">
${data}
\t\t\t</v:sampleDataSet>
\t\t</v:sampleDataSets>
\t</variableSet>
</variableSets>
</svg>
`;
}

// ---------- Plant matching ----------

export interface Symbol { id: number; botanical: string; common: string; code: string }

/** Lower case, strip cultivar quotes, punctuation and extra spaces. */
export function normalisePlant(s: string): string {
  return s.toLowerCase().replace(/[‘’'"“”]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Best symbol for a plant label from the plan. Order: exact code, exact
 * botanical, exact common name, then genus + species (first two words) of the
 * botanical name, then genus only. Returns how it matched so Jamie can see
 * weaker matches.
 */
export function matchSymbol(label: string, symbols: Symbol[]): { symbol: Symbol; how: "code" | "exact" | "species" | "genus" } | null {
  const n = normalisePlant(label);
  if (!n) return null;
  const words = n.split(" ");
  for (const s of symbols) if (s.code && normalisePlant(s.code) === n) return { symbol: s, how: "code" };
  for (const s of symbols) if (normalisePlant(s.botanical) === n || (s.common && normalisePlant(s.common) === n)) return { symbol: s, how: "exact" };
  if (words.length >= 2) {
    const sp = words.slice(0, 2).join(" ");
    for (const s of symbols) if (normalisePlant(s.botanical).split(" ").slice(0, 2).join(" ") === sp) return { symbol: s, how: "species" };
  }
  for (const s of symbols) {
    const genus = normalisePlant(s.botanical).split(" ")[0];
    if (genus && genus === words[0] && genus.length > 2) return { symbol: s, how: "genus" };
  }
  return null;
}
