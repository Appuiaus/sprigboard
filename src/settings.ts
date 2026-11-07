// Every business choice Jamie might want to change lives here, so she never needs a code change.
// One entry per setting: the Settings page form, validation, defaults and saving all come from this
// list. To add a setting, add an entry and read it with `st.<key>` where it's used.

export type SettingType = "text" | "email" | "area" | "toggle" | "number" | "select";

export interface SettingDef {
  key: string;
  label: string;
  type: SettingType;
  section: SectionId;
  default: string;
  hint?: string;
  full?: boolean;             // full width in the two-column grid
  min?: number; max?: number; step?: number;
  options?: [string, string][];
  maxLength?: number;
}

export type SectionId = "business" | "invoices" | "numbering" | "emails" | "plans" | "statuses" | "region";

export const SECTIONS: [SectionId, string, string][] = [
  ["business", "Business", "Your details, shown on invoices and title blocks."],
  ["invoices", "Invoices and GST", "How invoices are worked out and worded."],
  ["numbering", "Numbering", "How job and invoice numbers look."],
  ["emails", "Emails", "Invoices you email to clients."],
  ["plans", "Plans and title blocks", "How Claude reads plans and how plants are matched to your graphics."],
  ["statuses", "Job statuses", "Rename the stages a job goes through."],
  ["region", "Region and display", ""],
];

export const TIMEZONES: [string, string][] = [
  ["Australia/Brisbane", "Brisbane (no daylight saving)"], ["Australia/Sydney", "Sydney, Melbourne, Canberra, Hobart"],
  ["Australia/Adelaide", "Adelaide"], ["Australia/Darwin", "Darwin"], ["Australia/Perth", "Perth"],
  ["Pacific/Auckland", "New Zealand"], ["UTC", "UTC"],
];

const PLACEHOLDERS_LINE = "Placeholders: {job} {project} {address} {client} {size}. Empty ones are left out.";
const PLACEHOLDERS_MAIL = "Placeholders: {type} {number} {business} {client} {contact} {total} {due} {signature}.";

export const SETTINGS: SettingDef[] = [
  // Business
  { key: "business_name", label: "Business name", type: "text", section: "business", default: "Your business name", maxLength: 120 },
  { key: "abn", label: "ABN", type: "text", section: "business", default: "", maxLength: 20 },
  { key: "email", label: "Email", type: "email", section: "business", default: "", hint: "Replies to invoices you email go here." },
  { key: "phone", label: "Phone", type: "text", section: "business", default: "", maxLength: 40 },
  { key: "address", label: "Business address", type: "area", section: "business", default: "", full: true, maxLength: 400 },
  { key: "drawn_by", label: "Drawn by (title block)", type: "text", section: "business", default: "Jamie", maxLength: 80 },
  // Invoices and GST
  { key: "gst_registered", label: "Registered for GST", type: "toggle", section: "invoices", default: "0", full: true,
    hint: "Your business is registered for GST. Invoices that add GST are then titled Tax invoice." },
  { key: "gst_on_invoices", label: "Add GST to invoices", type: "toggle", section: "invoices", default: "0", full: true,
    hint: "Adds GST on top of the price on new invoices, separately from the setting above. You can still switch GST on or off for each invoice. Existing invoices don't change." },
  { key: "gst_rate", label: "GST rate (%)", type: "number", section: "invoices", default: "10", min: 0, max: 100, step: 0.01,
    hint: "Applies to new invoices and to invoices you edit afterwards." },
  { key: "payment_terms_days", label: "Payment terms (days)", type: "number", section: "invoices", default: "14", min: 0, max: 365, step: 1 },
  { key: "invoice_line_template", label: "Invoice line wording", type: "text", section: "invoices", full: true,
    default: "Presentation drawing {job}, {project}, {address} ({size})", hint: PLACEHOLDERS_LINE, maxLength: 300 },
  { key: "payment_details", label: "Payment details", type: "area", section: "invoices", default: "", full: true,
    hint: "Bank name, BSB and account number, printed on every invoice.", maxLength: 1000 },
  { key: "invoice_default_notes", label: "Notes on every new invoice", type: "area", section: "invoices", default: "", full: true,
    hint: "For example a thank-you or late-payment terms. You can still edit them on each invoice.", maxLength: 1000 },
  // Numbering
  { key: "job_prefix", label: "Job number prefix", type: "text", section: "numbering", default: "J-", maxLength: 12 },
  { key: "job_pad", label: "Job number digits", type: "number", section: "numbering", default: "4", min: 1, max: 8, step: 1, hint: "4 gives J-0007." },
  { key: "invoice_prefix", label: "Invoice number prefix", type: "text", section: "numbering", default: "INV-", maxLength: 12 },
  { key: "invoice_pad", label: "Invoice number digits", type: "number", section: "numbering", default: "4", min: 1, max: 8, step: 1 },
  // Emails
  { key: "email_sender_name", label: "Sender name", type: "text", section: "emails", default: "", maxLength: 80,
    hint: "The name clients see on invoice emails. Leave blank to use your business name." },
  { key: "invoice_email_subject", label: "Invoice email subject", type: "text", section: "emails", full: true,
    default: "{type} {number} from {business}", hint: PLACEHOLDERS_MAIL, maxLength: 200 },
  { key: "invoice_email_message", label: "Invoice email message", type: "area", section: "emails", full: true,
    default: "Hi {contact},\n\nPlease find invoice {number} for {total} below. It's due on {due}.\n\nThanks,\n{signature}", hint: PLACEHOLDERS_MAIL, maxLength: 2000 },
  // Plans and title blocks
  { key: "default_disclaimer", label: "Default disclaimer", type: "area", section: "plans", full: true,
    default: "Not for construction. For presentation purposes only.", hint: "Used on title blocks when the client has no disclaimer of their own.", maxLength: 500 },
  { key: "plan_reading_instructions", label: "Extra instructions for plan reading", type: "area", section: "plans", full: true, default: "",
    hint: "Anything Claude should also do or skip when it reads a plan, e.g. \"Ignore irrigation notes\" or \"List pot sizes in the detail\".", maxLength: 2000 },
  { key: "match_species", label: "Match plants by species", type: "toggle", section: "plans", default: "1", full: true,
    hint: "A cultivar on the plan (e.g. Westringia 'Grey Box') can use the graphic for its species." },
  { key: "match_genus", label: "Match plants by genus", type: "toggle", section: "plans", default: "1", full: true,
    hint: "If nothing closer exists, any graphic of the same genus is suggested (flagged as genus only)." },
  // Job statuses
  { key: "status_label_new", label: "New", type: "text", section: "statuses", default: "New", maxLength: 30 },
  { key: "status_label_drawing", label: "Drawing", type: "text", section: "statuses", default: "Drawing", maxLength: 30 },
  { key: "status_label_sent", label: "Sent to client", type: "text", section: "statuses", default: "Sent to client", maxLength: 30 },
  { key: "status_label_invoiced", label: "Invoiced", type: "text", section: "statuses", default: "Invoiced", maxLength: 30 },
  { key: "status_label_done", label: "Done", type: "text", section: "statuses", default: "Done", maxLength: 30 },
  // Region and display
  { key: "timezone", label: "Time zone", type: "select", section: "region", default: "Australia/Brisbane", options: TIMEZONES,
    hint: "Used for today's date on invoices and the times on time entries." },
  { key: "show_onboarding", label: "Show the getting-started checklist", type: "toggle", section: "region", default: "1", full: true },
];

export const SETTING_KEYS = new Set(SETTINGS.map((d) => d.key));

/** Stored values over defaults, so a new setting works before anyone saves it. */
export function withDefaults(stored: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of SETTINGS) out[d.key] = d.default;
  return { ...out, ...stored };
}

/** Validates one submitted value. Returns the value to store, or an error message. */
export function parseSetting(d: SettingDef, raw: File | string | null): { value: string } | { error: string } {
  if (d.type === "toggle") return { value: raw === "1" ? "1" : "0" };
  const v = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (d.type === "number") {
    const num = Number(v);
    if (v === "" || !Number.isFinite(num)) return { error: `${d.label}: enter a number.` };
    if ((d.min !== undefined && num < d.min) || (d.max !== undefined && num > d.max)) return { error: `${d.label}: use a number from ${d.min} to ${d.max}.` };
    if (d.step === 1 && !Number.isInteger(num)) return { error: `${d.label}: use a whole number.` };
    return { value: String(num) };
  }
  if (d.type === "select") return d.options?.some(([k]) => k === v) ? { value: v } : { error: `${d.label}: choose one of the options.` };
  if (d.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: `${d.label}: enter a valid email address.` };
  if (d.maxLength && v.length > d.maxLength) return { error: `${d.label}: keep it under ${d.maxLength} characters.` };
  if (d.section === "statuses" && !v) return { error: `Give the "${d.default}" status a name.` };
  return { value: v };
}

/** Fills {placeholders}; with tidy=true, drops the separators around empty ones ("A, , B ()" → "A, B"). */
export function fillTemplate(template: string, vars: Record<string, string>, tidy = false): string {
  let out = template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
  if (tidy) out = out.replace(/\(\s*\)/g, "").replace(/(,\s*)+(?=,|$)/g, "").replace(/^\s*,\s*/, "").replace(/\s{2,}/g, " ").replace(/\s+([,.)])/g, "$1").trim();
  return out;
}

export const JOB_STATUS_KEYS = ["new", "drawing", "sent", "invoiced", "done"] as const;

export function jobStatuses(st: Record<string, string>): [string, string][] {
  return JOB_STATUS_KEYS.map((k) => [k, st[`status_label_${k}`] || k]);
}
