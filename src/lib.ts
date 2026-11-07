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

/** addGst: whether this invoice adds GST; ratePercent: e.g. 10 for 10%. */
export function invoiceTotals(lines: InvoiceLine[], addGst: boolean, ratePercent = GST_RATE * 100) {
  const subtotal = lines.reduce((s, l) => s + Math.round(l.qty * l.unit_cents), 0);
  const gst = addGst ? Math.round((subtotal * ratePercent) / 100) : 0;
  return { subtotal_cents: subtotal, gst_cents: gst, total_cents: subtotal + gst };
}

/** ISO date (YYYY-MM-DD) plus n days, in UTC. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const DEFAULT_TZ = "Australia/Brisbane";

/** Today's date in a time zone (Jamie's, from Settings), as YYYY-MM-DD. */
export function todayIn(tz = DEFAULT_TZ, now = new Date()): string {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now); }
  catch { return new Intl.DateTimeFormat("en-CA", { timeZone: DEFAULT_TZ }).format(now); }
}
/** @deprecated use todayIn(st.timezone) */
export const todayBrisbane = (now = new Date()) => todayIn(DEFAULT_TZ, now);

/** "10" → "10", "12.5" → "12.5" for labels like "GST (10%)". */
export const percentLabel = (rate: number) => `${Math.round(rate * 100) / 100}%`;

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
export function matchSymbol(label: string, symbols: Symbol[], opts: { species?: boolean; genus?: boolean } = {}): { symbol: Symbol; how: "code" | "exact" | "species" | "genus" } | null {
  const allowSpecies = opts.species ?? true, allowGenus = opts.genus ?? true;
  const n = normalisePlant(label);
  if (!n) return null;
  const words = n.split(" ");
  for (const s of symbols) if (s.code && normalisePlant(s.code) === n) return { symbol: s, how: "code" };
  for (const s of symbols) if (normalisePlant(s.botanical) === n || (s.common && normalisePlant(s.common) === n)) return { symbol: s, how: "exact" };
  if (allowSpecies && words.length >= 2) {
    const sp = words.slice(0, 2).join(" ");
    for (const s of symbols) if (normalisePlant(s.botanical).split(" ").slice(0, 2).join(" ") === sp) return { symbol: s, how: "species" };
  }
  if (allowGenus) for (const s of symbols) {
    const genus = normalisePlant(s.botanical).split(" ")[0];
    if (genus && genus === words[0] && genus.length > 2) return { symbol: s, how: "genus" };
  }
  return null;
}

// ---------- CSV import ----------

/** RFC 4180-ish CSV parser: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Reads botanical/common/code columns by header name (case-insensitive; "name" also means botanical). */
export function plantRowsFromCsv(text: string): { rows: { botanical: string; common: string; code: string }[]; skipped: number } | { error: string } {
  const all = parseCsv(text);
  if (all.length < 2) return { error: "The file needs a header row and at least one plant." };
  const head = all[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => head.findIndex((h) => names.includes(h));
  const b = col("botanical", "botanical name", "name", "plant"), cm = col("common", "common name"), cd = col("code", "plan code");
  if (b < 0) return { error: 'Add a "botanical" column header to the first row.' };
  if (all.length - 1 > 2000) return { error: "Import at most 2000 plants at a time." };
  let skipped = 0;
  const rows = all.slice(1).flatMap((r) => {
    const botanical = (r[b] ?? "").trim().slice(0, 200);
    if (!botanical) { skipped++; return []; }
    return [{ botanical, common: cm >= 0 ? (r[cm] ?? "").trim().slice(0, 200) : "", code: cd >= 0 ? (r[cd] ?? "").trim().slice(0, 40) : "" }];
  });
  return { rows, skipped };
}

// ---------- Time ----------

/** "90", "90m", "1:30", "1h 30m", "1.5h", "2 h" → minutes. Null when unreadable or over 24 hours. */
export function parseDuration(input: string): number | null {
  const t = input.trim().toLowerCase().replace(/\s+/g, " ");
  let m: RegExpExecArray | null;
  let minutes: number | null = null;
  if ((m = /^(\d{1,2}):([0-5]\d)$/.exec(t))) minutes = Number(m[1]) * 60 + Number(m[2]);
  else if ((m = /^(\d+(?:\.\d+)?) ?h(?:rs?|ours?)?(?: ?(\d{1,2}) ?m(?:ins?|inutes?)?)?$/.exec(t))) minutes = Math.round(Number(m[1]) * 60) + Number(m[2] ?? 0);
  else if ((m = /^(\d{1,4}) ?(?:m|mins?|minutes?)?$/.exec(t))) minutes = Number(m[1]);
  return minutes !== null && minutes > 0 && minutes <= 24 * 60 ? minutes : null;
}

export function formatMinutes(total: number): string {
  const m = Math.max(0, Math.round(total));
  const h = Math.floor(m / 60), r = m % 60;
  return h ? (r ? `${h} h ${r} min` : `${h} h`) : `${r} min`;
}

/** D1 datetime('now') strings ("YYYY-MM-DD HH:MM:SS", UTC) → minutes between, at least 1. */
export function minutesBetween(start: string, end: string): number {
  const a = Date.parse(start.replace(" ", "T") + "Z"), b = Date.parse(end.replace(" ", "T") + "Z");
  return Math.max(1, Math.round((b - a) / 60000));
}

/** A D1 UTC timestamp in a time zone, e.g. "7 Nov, 2:05 pm". */
export function localTime(utc: string, tz = DEFAULT_TZ): string {
  const d = new Date(utc.replace(" ", "T") + "Z");
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  try { return new Intl.DateTimeFormat("en-AU", { ...opts, timeZone: tz }).format(d); }
  catch { return new Intl.DateTimeFormat("en-AU", { ...opts, timeZone: DEFAULT_TZ }).format(d); }
}
export const brisbaneTime = (utc: string) => localTime(utc, DEFAULT_TZ);

// ---------- BAS quarters ----------

/** "2026-11-07" → "2026-Q4" (calendar quarter; BAS quarters are Jul to Sep, Oct to Dec, Jan to Mar, Apr to Jun). */
export function quarterOf(isoDate: string): string {
  const m = Number(isoDate.slice(5, 7));
  return `${isoDate.slice(0, 4)}-Q${Math.ceil(m / 3)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-Q3" → { from: "2026-07-01", to: "2026-09-30", label: "Jul to Sep 2026" }. */
export function quarterRange(q: string): { from: string; to: string; label: string } | null {
  const m = /^(\d{4})-Q([1-4])$/.exec(q);
  if (!m) return null;
  const y = Number(m[1]), first = (Number(m[2]) - 1) * 3; // 0-based month
  const last = new Date(Date.UTC(y, first + 3, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return { from: `${y}-${pad(first + 1)}-01`, to: `${y}-${pad(first + 3)}-${pad(last)}`, label: `${MONTHS[first]} to ${MONTHS[first + 2]} ${y}` };
}
