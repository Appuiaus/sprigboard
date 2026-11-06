// Sprigboard: Jamie's landscape-plan studio.
// Jobs register, plan reading with Claude, plant library matching, title-block
// export for Illustrator, size-tier pricing and invoices.
// Every request must carry a valid Cloudflare Access token (fails closed).

import { verifyAccess, type AccessContext, type AccessEnv } from "./access";
import { extractPlan, ExtractionError, isSupportedPlan, ITEM_KINDS } from "./extract";
import {
  addDays, continueFrom, esc, formatDollars, formatNumber, invoiceTotals, matchSymbol, parseDollars,
  titleBlockCsv, titleBlockXml, toCsv, todayBrisbane, type InvoiceLine, type Symbol, type TitleBlock,
} from "./lib";
import {
  area, badge, confirmDelete, dialog, field, formDialog, icon, iconBtn, layout, pills, select, table, toggle,
} from "./ui";

export interface Env extends AccessEnv {
  DB: D1Database;
  /** R2 bucket for plans, plant graphics and logos. Optional until R2 is turned on in the account. */
  FILES?: R2Bucket;
  ANTHROPIC_API_KEY?: string;
  /** Local development only (.dev.vars): skips Access when the request is to localhost. */
  DEV_ACCESS_EMAIL?: string;
}

type Row = Record<string, unknown>;
type Ctx = { env: Env; req: Request; url: URL; email: string };

const JOB_STATUSES: [string, string][] = [["new", "New"], ["drawing", "Drawing"], ["sent", "Sent to client"], ["invoiced", "Invoiced"], ["done", "Done"]];
const INVOICE_STATUSES: [string, string][] = [["draft", "Draft"], ["sent", "Sent"], ["paid", "Paid"]];
const KIND_NAMES: Record<string, string> = { plant: "Plant", street: "Street", dimension: "Dimension", marking: "Marking", note: "Note" };
const NO_STORAGE = "File storage isn't turned on yet (R2 needs enabling in the Cloudflare account). Everything else works.";
const MAX_UPLOAD = 30 * 1024 * 1024; // the Claude API takes requests up to 32 MB

// ---------- small helpers ----------

const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const n = (v: unknown) => Number(v ?? 0);

function redirect(to: string, msg?: string, err = false): Response {
  const u = new URL(to, "https://x");
  if (msg) { u.searchParams.set("m", msg); if (err) u.searchParams.set("e", "1"); }
  return new Response(null, { status: 303, headers: { location: u.pathname + u.search + u.hash } });
}

function flashOf(url: URL) {
  const m = url.searchParams.get("m");
  return m ? { msg: m, err: url.searchParams.get("e") === "1" } : null;
}

function notFound(c: Ctx, what = "page") {
  const r = layout({ title: "Not found", path: c.url.pathname, email: c.email, body: `<h1>Not found</h1><p class="sub">That ${esc(what)} doesn't exist or was deleted.</p><a class="btn" href="/">Back to jobs</a>` });
  return new Response(r.body, { status: 404, headers: r.headers });
}

function download(body: string, filename: string, type: string): Response {
  return new Response(body, { headers: { "content-type": type, "content-disposition": `attachment; filename="${filename.replace(/[^\w.-]+/g, "_")}"`, "cache-control": "no-store" } });
}

async function settings(env: Env): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

/** Atomically takes the next number in a series ("job" or "invoice"). */
async function nextNumber(env: Env, series: "job" | "invoice"): Promise<string> {
  const st = await settings(env);
  const row = await env.DB.prepare(
    `UPDATE settings SET value = CAST(value AS INTEGER) + 1 WHERE key = ? RETURNING CAST(value AS INTEGER) - 1 AS n`,
  ).bind(`${series}_next`).first<{ n: number }>();
  return formatNumber(st[`${series}_prefix`] ?? "", row?.n ?? 1, Number(st[`${series}_pad`] ?? 4));
}

const clientsList = (env: Env) =>
  env.DB.prepare(`SELECT * FROM clients WHERE deleted_at IS NULL ORDER BY name`).all<Row>().then((r) => r.results);
const tiersList = (env: Env) =>
  env.DB.prepare(`SELECT * FROM size_tiers WHERE deleted_at IS NULL ORDER BY sort, id`).all<Row>().then((r) => r.results);
const symbolsList = (env: Env) =>
  env.DB.prepare(`SELECT * FROM plant_symbols WHERE deleted_at IS NULL ORDER BY botanical`).all<Row>().then((r) => r.results);

const fileKey = (prefix: string, name: string) => `${prefix}/${crypto.randomUUID()}-${name.replace(/[^\w.-]+/g, "_").slice(-80)}`;

async function serveObject(env: Env, key: string | null, filename: string, mime: string): Promise<Response> {
  if (!key) return new Response("Not found", { status: 404 });
  if (!env.FILES) return new Response(NO_STORAGE, { status: 503 });
  const obj = await env.FILES.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": mime || "application/octet-stream",
      "content-disposition": `inline; filename="${filename.replace(/[^\w.-]+/g, "_")}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      // A served SVG must not run script.
      "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
    },
  });
}

const fileSize = (b: number) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

const isImage = (mime: string) => /^image\/(png|jpeg|gif|webp|svg\+xml)$/.test(mime);

// ---------- Jobs ----------

async function jobsPage(c: Ctx): Promise<Response> {
  const show = c.url.searchParams.get("show") ?? "open";
  const where = show === "all" ? "" : "AND j.status <> 'done'";
  const { results } = await c.env.DB.prepare(
    `SELECT j.*, c.name AS client_name, t.name AS tier_name,
            (SELECT COUNT(*) FROM plan_files f WHERE f.job_id = j.id AND f.deleted_at IS NULL) AS files,
            (SELECT COUNT(*) FROM checklist_items i WHERE i.job_id = j.id AND i.deleted_at IS NULL) AS items,
            (SELECT COUNT(*) FROM checklist_items i WHERE i.job_id = j.id AND i.deleted_at IS NULL AND i.done = 1) AS done_items
       FROM jobs j LEFT JOIN clients c ON c.id = j.client_id LEFT JOIN size_tiers t ON t.id = j.tier_id
      WHERE j.deleted_at IS NULL ${where} ORDER BY j.id DESC`,
  ).all<Row>();
  const [clients, tiers] = await Promise.all([clientsList(c.env), tiersList(c.env)]);
  const rows = results.map((j) => [
    `<a href="/jobs/${j.id}"><b>${esc(j.job_number)}</b></a>`,
    `${esc(j.project) || '<span class="muted">No project name</span>'}<div class="muted small">${esc(j.site_address)}</div>`,
    esc(j.client_name) || '<span class="muted">None</span>',
    esc(j.tier_name) || '<span class="muted">Not set</span>',
    n(j.items) ? `${n(j.done_items)} / ${n(j.items)}` : `<span class="muted">${n(j.files) ? "Not read" : "No plan"}</span>`,
    statusBadge(s(j.status)),
    iconBtn({ icon: "eye", label: `Open job ${s(j.job_number)}`, href: `/jobs/${j.id}` }) +
      iconBtn({ icon: "bin", label: `Delete job ${s(j.job_number)}`, dialog: `del-job-${j.id}`, danger: true }),
  ]);
  const dels = results.map((j) => confirmDelete(`del-job-${j.id}`, `job ${s(j.job_number)}`, `/jobs/${j.id}/delete`)).join("");
  const body = `<div class="bar"><h1>Jobs</h1>
    <a class="btn" href="/?show=${show === "all" ? "open" : "all"}">${show === "all" ? "Hide done jobs" : "Show done jobs"}</a>
    ${iconBtn({ icon: "plus", label: "New job", dialog: "new-job", attrs: 'style="width:38px;height:38px"' }).replace('class="ib"', 'class="ib primary"')}</div>
    <p class="sub">Each job gets the next job number. Upload the plan, let Claude read it, then tick items off as you draw.</p>
    ${table(["Job", "Project and site", "Client", "Size", "Checklist", "Status", "Actions"], rows, "No jobs yet. Press + to add the first one.")}
    ${formDialog("new-job", "New job", "/jobs", jobFields({}, clients, tiers), "Create job")}${dels}`;
  return layout({ title: "Jobs", path: c.url.pathname, email: c.email, body, flash: flashOf(c.url) });
}

function statusBadge(st: string): string {
  const name = JOB_STATUSES.find(([k]) => k === st)?.[1] ?? INVOICE_STATUSES.find(([k]) => k === st)?.[1] ?? st;
  const tone = st === "done" || st === "paid" ? "ok" : st === "new" || st === "draft" ? "muted" : st === "sent" || st === "invoiced" ? "warn" : "";
  return badge(name, tone);
}

function jobFields(j: Row, clients: Row[], tiers: Row[]): string {
  return `${field("project", "Project or end client", s(j.project), { full: true, hint: "Shown on the title block, e.g. the homeowner's name." })}
    ${field("site_address", "Site address", s(j.site_address), { full: true })}
    ${select("client_id", "Client", [["", "None"], ...clients.map((c) => [s(c.id), s(c.name)] as [string, string])], s(j.client_id))}
    ${field("scale", "Drawing scale", s(j.scale), { hint: "e.g. 1:200 @ A3" })}
    ${pills("tier_id", "Job size", [["", "Not set"], ...tiers.map((t) => [s(t.id), `${s(t.name)}${n(t.price_cents) ? ` · ${formatDollars(n(t.price_cents))}` : ""}`] as [string, string])], s(j.tier_id))}
    ${area("scope", "Scope of works", s(j.scope))}
    ${j.id ? pills("status", "Status", JOB_STATUSES, s(j.status)) : ""}
    ${area("notes", "Notes", s(j.notes), { rows: 2 })}`;
}

function jobValues(f: FormData) {
  const v = (k: string) => s(f.get(k)).trim();
  const id = (k: string) => (v(k) ? Number(v(k)) : null);
  return { project: v("project"), site_address: v("site_address"), client_id: id("client_id"), tier_id: id("tier_id"), scale: v("scale"), scope: v("scope"), notes: v("notes"), status: v("status") };
}

async function createJob(c: Ctx): Promise<Response> {
  const v = jobValues(await c.req.formData());
  const num = await nextNumber(c.env, "job");
  const row = await c.env.DB.prepare(
    `INSERT INTO jobs (job_number, client_id, project, site_address, scope, tier_id, scale, notes) VALUES (?,?,?,?,?,?,?,?) RETURNING id`,
  ).bind(num, v.client_id, v.project, v.site_address, v.scope, v.tier_id, v.scale, v.notes).first<{ id: number }>();
  return redirect(`/jobs/${row!.id}`, `Job ${num} created.`);
}

async function updateJob(c: Ctx, id: number): Promise<Response> {
  const v = jobValues(await c.req.formData());
  const status = JOB_STATUSES.some(([k]) => k === v.status) ? v.status : "new";
  await c.env.DB.prepare(
    `UPDATE jobs SET client_id=?, project=?, site_address=?, scope=?, tier_id=?, scale=?, notes=?, status=? WHERE id=? AND deleted_at IS NULL`,
  ).bind(v.client_id, v.project, v.site_address, v.scope, v.tier_id, v.scale, v.notes, status, id).run();
  return redirect(`/jobs/${id}`, "Job saved.");
}

async function getJob(env: Env, id: number) {
  return env.DB.prepare(
    `SELECT j.*, c.name AS client_name, c.disclaimer AS client_disclaimer, c.copyright AS client_copyright,
            t.name AS tier_name, t.price_cents AS tier_price
       FROM jobs j LEFT JOIN clients c ON c.id = j.client_id AND c.deleted_at IS NULL
       LEFT JOIN size_tiers t ON t.id = j.tier_id WHERE j.id = ? AND j.deleted_at IS NULL`,
  ).bind(id).first<Row>();
}

async function jobPage(c: Ctx, id: number): Promise<Response> {
  const j = await getJob(c.env, id);
  if (!j) return notFound(c, "job");
  const [clients, tiers, symbols, st] = await Promise.all([clientsList(c.env), tiersList(c.env), symbolsList(c.env), settings(c.env)]);
  const files = (await c.env.DB.prepare(`SELECT * FROM plan_files WHERE job_id=? AND deleted_at IS NULL ORDER BY id`).bind(id).all<Row>()).results;
  const items = (await c.env.DB.prepare(`SELECT * FROM checklist_items WHERE job_id=? AND deleted_at IS NULL ORDER BY done, CASE kind WHEN 'plant' THEN 0 WHEN 'street' THEN 1 WHEN 'dimension' THEN 2 WHEN 'marking' THEN 3 ELSE 4 END, sort, id`).bind(id).all<Row>()).results;
  const invoices = (await c.env.DB.prepare(`SELECT * FROM invoices WHERE job_id=? AND deleted_at IS NULL ORDER BY id`).bind(id).all<Row>()).results;
  const syms = symbols as unknown as (Symbol & { r2_key: string | null; mime: string | null })[];
  const hasKey = !!c.env.ANTHROPIC_API_KEY;

  const fileRows = files.map((f) => {
    const stat = s(f.read_status) === "read" ? badge("Read", "ok") : s(f.read_status) === "failed" ? `${badge("Failed", "bad")}<div class="small muted">${esc(f.read_error)}</div>` : badge("Not read", "muted");
    const readable = isSupportedPlan(s(f.mime));
    return [
      `<a href="/files/${f.id}" target="_blank" rel="noopener">${esc(f.filename)}</a>${f.summary ? `<div class="small muted">${esc(f.summary)}</div>` : ""}`,
      fileSize(n(f.size)),
      stat,
      iconBtn({ icon: "eye", label: `View ${s(f.filename)}`, href: `/files/${f.id}`, attrs: 'target="_blank" rel="noopener"' }) +
        (readable ? `<form method="post" action="/files/${f.id}/read" data-busy="reading">${iconBtn({ icon: "sparkle", label: hasKey ? (s(f.read_status) === "read" ? "Read this plan again with Claude" : "Read this plan with Claude") : "Add the Claude API key to read plans", attrs: hasKey ? "" : "disabled" })}</form>` : "") +
        iconBtn({ icon: "bin", label: `Delete ${s(f.filename)}`, dialog: `del-file-${f.id}`, danger: true }),
    ];
  });

  const itemRows = items.map((i) => {
    const m = s(i.kind) === "plant" ? matchSymbol(s(i.label), syms) : null;
    const sym = m ? syms.find((x) => x.id === m.symbol.id) : null;
    const symCell = s(i.kind) !== "plant" ? "" : m
      ? `${sym?.r2_key && isImage(s(sym.mime)) ? `<img class="thumb" src="/symbols/${m.symbol.id}" alt=""> ` : ""}${esc(m.symbol.code || m.symbol.botanical)}${m.how === "exact" || m.how === "code" ? "" : ` ${badge(m.how === "species" ? "species match" : "genus only", "warn")}`}`
      : badge("No symbol", "bad");
    return {
      done: n(i.done) === 1,
      cells: [
        `<form method="post" action="/items/${i.id}/done" data-autosubmit>${toggle("done", `<span class="sr">Done</span>`, n(i.done) === 1).replace('class="tgl"', `class="tgl mini" aria-label="Mark done" data-tip="${n(i.done) ? "Mark not done" : "Mark done"}"`)}</form>`,
        esc(KIND_NAMES[s(i.kind)] ?? s(i.kind)),
        `<span class="lbl">${esc(i.label)}</span>`,
        esc(i.detail),
        esc(i.quantity),
        symCell,
        iconBtn({ icon: "pencil", label: "Edit item", dialog: `edit-item-${i.id}` }) +
          iconBtn({ icon: "bin", label: "Delete item", dialog: `del-item-${i.id}`, danger: true }),
      ],
    };
  });
  const itemTable = itemRows.length
    ? table(["Done", "Type", "On the plan", "Detail", "Qty", "Symbol", "Actions"], itemRows.map((r) => r.cells), "")
    : `<p class="empty">No checklist yet. Upload the plan and press ${icon("sparkle")} to have Claude read it, or add items by hand.</p>`;
  // Grey out and strike through rows already drawn.
  let k = 0;
  const itemTableStyled = itemTable.replace(/<tbody>([\s\S]*)<\/tbody>/, (_m, body: string) => `<tbody>${body.replace(/<tr>/g, () => (itemRows[k++]?.done ? '<tr class="done">' : "<tr>"))}</tbody>`);

  const kinds = ITEM_KINDS.map((x) => [x, KIND_NAMES[x]] as [string, string]);
  const itemDialogs = items.map((i) =>
    formDialog(`edit-item-${i.id}`, "Edit item", `/items/${i.id}`, itemFields(i, kinds)) + confirmDelete(`del-item-${i.id}`, `"${s(i.label)}"`, `/items/${i.id}/delete`)).join("");
  const fileDialogs = files.map((f) => confirmDelete(`del-file-${f.id}`, s(f.filename), `/files/${f.id}/delete`)).join("");

  const disclaimer = s(j.client_disclaimer) || st.default_disclaimer || "";
  const copyright = s(j.client_copyright);
  const invRows = invoices.map((iv) => [
    `<a href="/invoices/${iv.id}">${esc(iv.number)}</a>`, esc(iv.issued_on), `<span class="num">${formatDollars(n(iv.total_cents))}</span>`, statusBadge(s(iv.status)),
    iconBtn({ icon: "eye", label: `Open invoice ${s(iv.number)}`, href: `/invoices/${iv.id}` }),
  ]);

  const body = `<div class="bar"><h1>${esc(j.job_number)} ${j.project ? `· ${esc(j.project)}` : ""}</h1>
      ${statusBadge(s(j.status))}
      ${iconBtn({ icon: "pencil", label: "Edit job", dialog: "edit-job" })}
      ${iconBtn({ icon: "receipt", label: "Create an invoice for this job", dialog: "new-invoice" })}
      ${iconBtn({ icon: "bin", label: "Delete job", dialog: "del-job", danger: true })}</div>
    <p class="sub">${esc(j.site_address) || "No site address yet"}</p>
    <div class="cards">
      <div class="panel"><dl><dt>Client</dt><dd>${esc(j.client_name) || '<span class="muted">None</span>'}</dd>
        <dt>Size</dt><dd>${esc(j.tier_name) || '<span class="muted">Not set</span>'}${n(j.tier_price) ? ` · ${formatDollars(n(j.tier_price))}` : ""}</dd>
        <dt>Scale</dt><dd>${esc(j.scale) || '<span class="muted">Not set</span>'}</dd><dt>Created</dt><dd>${esc(s(j.created_at).slice(0, 10))}</dd></dl>
        ${j.scope ? `<p class="small">${esc(j.scope)}</p>` : ""}${j.notes ? `<p class="small muted">${esc(j.notes)}</p>` : ""}</div>
      <div class="panel"><b>Title block</b>
        <dl class="small" style="margin-top:6px"><dt>Disclaimer</dt><dd>${esc(disclaimer) || '<span class="muted">None</span>'}</dd>
        <dt>Copyright</dt><dd>${esc(copyright) || '<span class="muted">Not set for this client</span>'}</dd></dl>
        <p class="small muted">Download the job's details as Illustrator variables, then use Variables → Load Variable Library (or Import a CSV data set) in your template.</p>
        ${iconBtn({ icon: "download", label: "Title block for Illustrator (variable library XML)", href: `/jobs/${id}/title-block.xml`, download: true })}
        ${iconBtn({ icon: "file", label: "Title block as CSV", href: `/jobs/${id}/title-block.csv`, download: true })}</div>
    </div>
    <div class="bar"><h2>Plans</h2>${iconBtn({ icon: "upload", label: "Upload plan files", dialog: "upload" })}</div>
    ${c.env.FILES ? "" : `<div class="flash err">${NO_STORAGE}</div>`}
    ${hasKey ? "" : `<div class="flash err">Plan reading is off until the Claude API key is added (see SETUP in the repo). Everything else works.</div>`}
    <div class="flash" id="reading" hidden>Claude is reading the plan. This can take a minute or two for a detailed PDF; keep this page open.</div>
    ${table(["File", "Size", "Read", "Actions"], fileRows, "No plan uploaded yet.")}
    <div class="bar"><h2>Checklist</h2>
      ${iconBtn({ icon: "plus", label: "Add an item by hand", dialog: "new-item" })}
      ${items.length ? iconBtn({ icon: "download", label: "Checklist as CSV", href: `/jobs/${id}/checklist.csv`, download: true }) : ""}
      ${items.some((i) => i.kind === "plant") ? iconBtn({ icon: "leaf", label: "Plant list with matched symbols (CSV)", href: `/jobs/${id}/plants.csv`, download: true }) : ""}</div>
    <p class="sub small">Claude drafts this list from the plan. Check each item against the plan as you draw it; you have the final say.</p>
    ${itemTableStyled}
    ${invoices.length ? `<h2>Invoices</h2>${table(["Invoice", "Issued", "Total", "Status", "Actions"], invRows, "")}` : ""}
    ${formDialog("edit-job", `Edit ${esc(j.job_number)}`, `/jobs/${id}`, jobFields(j, clients, tiers))}
    ${confirmDelete("del-job", `job ${s(j.job_number)}`, `/jobs/${id}/delete`)}
    ${formDialog("upload", "Upload plan files", `/jobs/${id}/files`, `<label class="fld full"><span>Plan files</span><input type="file" name="files" multiple required accept="application/pdf,image/jpeg,image/png,image/webp,image/gif"><small>PDF, JPEG or PNG, up to 30 MB each.</small></label>`, "Upload", "multipart/form-data")}
    ${formDialog("new-item", "Add checklist item", `/jobs/${id}/items`, itemFields({ kind: "plant" }, kinds), "Add")}
    ${formDialog("new-invoice", `Invoice for ${esc(j.job_number)}`, `/jobs/${id}/invoice`, invoiceFromJobFields(j, st), "Create invoice")}
    ${itemDialogs}${fileDialogs}`;
  return layout({ title: s(j.job_number), path: c.url.pathname, email: c.email, body, flash: flashOf(c.url) });
}

function itemFields(i: Row, kinds: [string, string][]): string {
  return `${pills("kind", "Type", kinds, s(i.kind) || "plant")}
    ${field("label", "Text on the plan", s(i.label), { required: true, full: true, hint: "For plants, the botanical name as written." })}
    ${field("detail", "Detail", s(i.detail), { hint: "Common name, pot size, what a dimension measures…" })}
    ${field("quantity", "Quantity", s(i.quantity))}`;
}

function invoiceFromJobFields(j: Row, st: Record<string, string>): string {
  const desc = [`Presentation drawing ${s(j.job_number)}`, s(j.project), s(j.site_address)].filter(Boolean).join(", ") + (j.tier_name ? ` (${s(j.tier_name)})` : "");
  return `${field("description", "Line description", desc, { full: true })}
    ${field("amount", "Amount (AUD, before GST)", n(j.tier_price) ? (n(j.tier_price) / 100).toFixed(2) : "", { required: true, attrs: 'inputmode="decimal" placeholder="0.00"', hint: j.tier_name ? `From the ${esc(j.tier_name)} size price.` : "Set the job size to fill this in." })}
    ${field("issued_on", "Invoice date", todayBrisbane(), { type: "date" })}
    <p class="small muted full">${st.gst_registered === "1" ? "GST (10%) is added." : "No GST is added (not registered for GST; change in Settings)."} The invoice gets the next number and is saved as a draft.</p>`;
}

// ---------- Plan files ----------

async function uploadFiles(c: Ctx, jobId: number): Promise<Response> {
  if (!(await getJob(c.env, jobId))) return notFound(c, "job");
  if (!c.env.FILES) return redirect(`/jobs/${jobId}`, NO_STORAGE, true);
  const form = await c.req.formData();
  const files = form.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (!files.length) return redirect(`/jobs/${jobId}`, "Choose at least one file.", true);
  const skipped: string[] = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD) { skipped.push(`${f.name} (over 30 MB)`); continue; }
    const mime = f.type || "application/octet-stream";
    const key = fileKey(`plans/${jobId}`, f.name);
    await c.env.FILES!.put(key, f.stream(), { httpMetadata: { contentType: mime } });
    await c.env.DB.prepare(`INSERT INTO plan_files (job_id, r2_key, filename, mime, size) VALUES (?,?,?,?,?)`).bind(jobId, key, f.name, mime, f.size).run();
  }
  const done = files.length - skipped.length;
  return redirect(`/jobs/${jobId}`, `${done} file${done === 1 ? "" : "s"} uploaded.${skipped.length ? ` Skipped: ${skipped.join(", ")}.` : ""}`, skipped.length > 0 && done === 0);
}

async function readFile(c: Ctx, fileId: number): Promise<Response> {
  const f = await c.env.DB.prepare(`SELECT * FROM plan_files WHERE id=? AND deleted_at IS NULL`).bind(fileId).first<Row>();
  if (!f) return notFound(c, "file");
  const jobId = n(f.job_id);
  if (!c.env.ANTHROPIC_API_KEY) return redirect(`/jobs/${jobId}`, "Add the Claude API key first (see SETUP).", true);
  if (!isSupportedPlan(s(f.mime))) return redirect(`/jobs/${jobId}`, "Claude can read PDF, JPEG, PNG, GIF and WebP files.", true);
  if (!c.env.FILES) return redirect(`/jobs/${jobId}`, NO_STORAGE, true);
  const obj = await c.env.FILES.get(s(f.r2_key));
  if (!obj) return redirect(`/jobs/${jobId}`, "The stored file is missing.", true);
  try {
    const result = await extractPlan(c.env.ANTHROPIC_API_KEY, { mime: s(f.mime), bytes: await obj.arrayBuffer() }, s(f.filename));
    // Replace this file's earlier Claude items; keep anything Jamie added or already ticked.
    const stmts = [
      c.env.DB.prepare(`UPDATE checklist_items SET deleted_at = datetime('now') WHERE file_id=? AND source='claude' AND done=0 AND deleted_at IS NULL`).bind(fileId),
      ...result.items.map((it, idx) =>
        c.env.DB.prepare(`INSERT INTO checklist_items (job_id, file_id, kind, label, detail, quantity, source, sort) VALUES (?,?,?,?,?,?, 'claude', ?)`)
          .bind(jobId, fileId, it.kind, it.label, it.detail, it.quantity, idx)),
      c.env.DB.prepare(`UPDATE plan_files SET read_status='read', read_error=NULL, summary=? WHERE id=?`).bind(result.summary, fileId),
      // Fill blank job fields from the plan, never overwrite what Jamie typed.
      c.env.DB.prepare(`UPDATE jobs SET scale = CASE WHEN scale='' THEN ? ELSE scale END, site_address = CASE WHEN site_address='' THEN ? ELSE site_address END WHERE id=?`)
        .bind(result.scale, result.site_address, jobId),
    ];
    await c.env.DB.batch(stmts);
    return redirect(`/jobs/${jobId}`, `Claude found ${result.items.length} item${result.items.length === 1 ? "" : "s"} in ${s(f.filename)}. Check them against the plan.`);
  } catch (e) {
    const msg = e instanceof ExtractionError ? e.message : "Something went wrong reading the plan.";
    if (!(e instanceof ExtractionError)) console.error("extract failed", e);
    await c.env.DB.prepare(`UPDATE plan_files SET read_status='failed', read_error=? WHERE id=?`).bind(msg, fileId).run();
    return redirect(`/jobs/${jobId}`, msg, true);
  }
}

// ---------- Checklist ----------

function itemValues(f: FormData) {
  const kind = s(f.get("kind"));
  return {
    kind: (ITEM_KINDS as readonly string[]).includes(kind) ? kind : "note",
    label: s(f.get("label")).trim(), detail: s(f.get("detail")).trim(), quantity: s(f.get("quantity")).trim(),
  };
}

async function itemJob(env: Env, id: number) {
  return env.DB.prepare(`SELECT job_id FROM checklist_items WHERE id=? AND deleted_at IS NULL`).bind(id).first<{ job_id: number }>();
}

// ---------- Exports ----------

async function titleBlockFor(env: Env, id: number): Promise<TitleBlock | null> {
  const j = await getJob(env, id);
  if (!j) return null;
  const st = await settings(env);
  return {
    job_number: s(j.job_number), project: s(j.project), client: s(j.client_name), site_address: s(j.site_address),
    scale: s(j.scale), date: todayBrisbane(), disclaimer: s(j.client_disclaimer) || st.default_disclaimer || "",
    copyright: s(j.client_copyright), drawn_by: st.drawn_by ?? "",
  };
}

async function checklistCsv(c: Ctx, id: number, plantsOnly: boolean): Promise<Response> {
  const j = await getJob(c.env, id);
  if (!j) return notFound(c, "job");
  const items = (await c.env.DB.prepare(`SELECT * FROM checklist_items WHERE job_id=? AND deleted_at IS NULL ${plantsOnly ? "AND kind='plant'" : ""} ORDER BY kind, sort, id`).bind(id).all<Row>()).results;
  if (plantsOnly) {
    const syms = (await symbolsList(c.env)) as unknown as (Symbol & { filename: string | null })[];
    const rows = items.map((i) => {
      const m = matchSymbol(s(i.label), syms);
      const sym = m ? syms.find((x) => x.id === m.symbol.id) : undefined;
      return [s(i.label), s(i.detail), s(i.quantity), m ? (m.symbol.code || m.symbol.botanical) : "", m ? m.how : "none", sym?.filename ?? ""];
    });
    return download(toCsv([["plant", "detail", "quantity", "symbol", "match", "symbol_file"], ...rows]), `${s(j.job_number)}-plants.csv`, "text/csv; charset=utf-8");
  }
  const rows = items.map((i) => [KIND_NAMES[s(i.kind)] ?? s(i.kind), s(i.label), s(i.detail), s(i.quantity), n(i.done) ? "yes" : "no"]);
  return download(toCsv([["type", "text", "detail", "quantity", "done"], ...rows]), `${s(j.job_number)}-checklist.csv`, "text/csv; charset=utf-8");
}

// ---------- Plant library ----------

async function plantsPage(c: Ctx): Promise<Response> {
  const syms = await symbolsList(c.env);
  const rows = syms.map((p) => [
    p.r2_key && isImage(s(p.mime)) ? `<img class="thumb" src="/symbols/${p.id}" alt="">` : p.r2_key ? badge(s(p.filename).split(".").pop()?.toUpperCase() ?? "File", "muted") : '<span class="muted">None</span>',
    `<i>${esc(p.botanical)}</i>`, esc(p.common), esc(p.code),
    (p.r2_key ? iconBtn({ icon: "download", label: `Download ${s(p.filename)}`, href: `/symbols/${p.id}?download=1` }) : "") +
      iconBtn({ icon: "pencil", label: "Edit plant", dialog: `edit-plant-${p.id}` }) +
      iconBtn({ icon: "bin", label: "Delete plant", dialog: `del-plant-${p.id}`, danger: true }),
  ]);
  const dlgs = syms.map((p) => formDialog(`edit-plant-${p.id}`, "Edit plant", `/plants/${p.id}`, plantFields(p), "Save", "multipart/form-data") + confirmDelete(`del-plant-${p.id}`, s(p.botanical), `/plants/${p.id}/delete`)).join("");
  const body = `<div class="bar"><h1>Plant library</h1>${iconBtn({ icon: "plus", label: "Add a plant", dialog: "new-plant" }).replace('class="ib"', 'class="ib primary"')}</div>
    <p class="sub">Your plant graphics. Checklist plants are matched by code, then botanical or common name, then genus and species.</p>
    ${table(["Symbol", "Botanical name", "Common name", "Code", "Actions"], rows, "No plants yet. Add your plant graphics so jobs can match them.")}
    ${formDialog("new-plant", "Add a plant", "/plants", plantFields({}), "Add", "multipart/form-data")}${dlgs}`;
  return layout({ title: "Plant library", path: c.url.pathname, email: c.email, body, flash: flashOf(c.url) });
}

const plantFields = (p: Row) => `${field("botanical", "Botanical name", s(p.botanical), { required: true, full: true, hint: "e.g. Lomandra longifolia 'Tanika'" })}
  ${field("common", "Common name", s(p.common))}${field("code", "Code", s(p.code), { hint: "The code used on plans, if any (e.g. LT)." })}
  <label class="fld full"><span>Symbol file</span><input type="file" name="file" accept="image/svg+xml,image/png,image/jpeg,image/webp,.ai,.eps,.pdf"><small>${p.filename ? `Current: ${esc(p.filename)}. Choose a file to replace it.` : "SVG or PNG shows a preview; AI and EPS files are stored for download."}</small></label>`;

async function savePlant(c: Ctx, id: number | null): Promise<Response> {
  const f = await c.req.formData();
  const botanical = s(f.get("botanical")).trim();
  if (!botanical) return redirect("/plants", "The botanical name is required.", true);
  const file = f.get("file");
  let fileCols: [string, string, string] | null = null;
  if (file && typeof file !== "string" && file.size > 0) {
    if (!c.env.FILES) return redirect("/plants", NO_STORAGE, true);
    if (file.size > 10 * 1024 * 1024) return redirect("/plants", "Symbol files can be up to 10 MB.", true);
    const key = fileKey("symbols", file.name);
    const mime = file.type || "application/octet-stream";
    await c.env.FILES!.put(key, file.stream(), { httpMetadata: { contentType: mime } });
    fileCols = [key, file.name, mime];
  }
  const common = s(f.get("common")).trim(), code = s(f.get("code")).trim();
  if (id === null) {
    await c.env.DB.prepare(`INSERT INTO plant_symbols (botanical, common, code, r2_key, filename, mime) VALUES (?,?,?,?,?,?)`)
      .bind(botanical, common, code, fileCols?.[0] ?? null, fileCols?.[1] ?? null, fileCols?.[2] ?? null).run();
    return redirect("/plants", `${botanical} added.`);
  }
  await c.env.DB.prepare(`UPDATE plant_symbols SET botanical=?, common=?, code=? WHERE id=?`).bind(botanical, common, code, id).run();
  if (fileCols) await c.env.DB.prepare(`UPDATE plant_symbols SET r2_key=?, filename=?, mime=? WHERE id=?`).bind(...fileCols, id).run();
  return redirect("/plants", `${botanical} saved.`);
}

// ---------- Clients ----------

async function clientsPage(c: Ctx): Promise<Response> {
  const list = await clientsList(c.env);
  const rows = list.map((cl) => [
    cl.logo_key ? `<img class="thumb" src="/logos/${cl.id}" alt="">` : '<span class="muted">None</span>',
    `<b>${esc(cl.name)}</b>${cl.contact ? `<div class="small muted">${esc(cl.contact)}</div>` : ""}`,
    esc(cl.email),
    cl.copyright ? badge("Set", "ok") : badge("Missing", "warn"),
    iconBtn({ icon: "pencil", label: `Edit ${s(cl.name)}`, dialog: `edit-client-${cl.id}` }) +
      iconBtn({ icon: "bin", label: `Delete ${s(cl.name)}`, dialog: `del-client-${cl.id}`, danger: true }),
  ]);
  const dlgs = list.map((cl) => formDialog(`edit-client-${cl.id}`, `Edit ${esc(cl.name)}`, `/clients/${cl.id}`, clientFields(cl), "Save", "multipart/form-data") + confirmDelete(`del-client-${cl.id}`, s(cl.name), `/clients/${cl.id}/delete`)).join("");
  const body = `<div class="bar"><h1>Clients</h1>${iconBtn({ icon: "plus", label: "Add a client", dialog: "new-client" }).replace('class="ib"', 'class="ib primary"')}</div>
    <p class="sub">Who you draw for and invoice. Each client's copyright line, disclaimer and logo go on their title blocks.</p>
    ${table(["Logo", "Client", "Email", "Copyright", "Actions"], rows, "No clients yet. Add Shane's business first.")}
    ${formDialog("new-client", "Add a client", "/clients", clientFields({}), "Add", "multipart/form-data")}${dlgs}`;
  return layout({ title: "Clients", path: c.url.pathname, email: c.email, body, flash: flashOf(c.url) });
}

const clientFields = (cl: Row) => `${field("name", "Business name", s(cl.name), { required: true, full: true })}
  ${field("contact", "Contact person", s(cl.contact))}${field("email", "Email", s(cl.email), { type: "email" })}
  ${area("address", "Billing address", s(cl.address), { rows: 2 })}
  ${area("copyright", "Copyright statement", s(cl.copyright), { rows: 2, hint: "The client supplies this. It goes on every drawing for them." })}
  ${area("disclaimer", "Disclaimer", s(cl.disclaimer), { rows: 2, hint: "Leave blank to use the default from Settings." })}
  <label class="fld full"><span>Logo</span><input type="file" name="logo" accept="image/svg+xml,image/png,image/jpeg,image/webp"><small>${cl.logo_key ? "A logo is stored. Choose a file to replace it." : "Shown on invoices and kept for the title block."}</small></label>`;

async function saveClient(c: Ctx, id: number | null): Promise<Response> {
  const f = await c.req.formData();
  const v = (k: string) => s(f.get(k)).trim();
  if (!v("name")) return redirect("/clients", "The business name is required.", true);
  const logo = f.get("logo");
  let logoKey: string | null = null;
  if (logo && typeof logo !== "string" && logo.size > 0) {
    if (!c.env.FILES) return redirect("/clients", NO_STORAGE, true);
    if (!isImage(logo.type) || logo.size > 5 * 1024 * 1024) return redirect("/clients", "The logo must be an image up to 5 MB.", true);
    logoKey = fileKey("logos", logo.name);
    await c.env.FILES!.put(logoKey, logo.stream(), { httpMetadata: { contentType: logo.type } });
  }
  const vals = [v("name"), v("contact"), v("email"), v("address"), v("copyright"), v("disclaimer")];
  if (id === null) {
    await c.env.DB.prepare(`INSERT INTO clients (name, contact, email, address, copyright, disclaimer, logo_key) VALUES (?,?,?,?,?,?,?)`).bind(...vals, logoKey).run();
    return redirect("/clients", `${v("name")} added.`);
  }
  await c.env.DB.prepare(`UPDATE clients SET name=?, contact=?, email=?, address=?, copyright=?, disclaimer=? WHERE id=?`).bind(...vals, id).run();
  if (logoKey) await c.env.DB.prepare(`UPDATE clients SET logo_key=? WHERE id=?`).bind(logoKey, id).run();
  return redirect("/clients", `${v("name")} saved.`);
}

// ---------- Invoices ----------

async function createInvoiceFromJob(c: Ctx, jobId: number): Promise<Response> {
  const j = await getJob(c.env, jobId);
  if (!j) return notFound(c, "job");
  const f = await c.req.formData();
  const cents = parseDollars(s(f.get("amount")));
  if (cents === null) return redirect(`/jobs/${jobId}`, "Enter the amount as dollars, e.g. 250 or 250.00.", true);
  const st = await settings(c.env);
  const issued = /^\d{4}-\d{2}-\d{2}$/.test(s(f.get("issued_on"))) ? s(f.get("issued_on")) : todayBrisbane();
  const lines: InvoiceLine[] = [{ description: s(f.get("description")).trim() || `Presentation drawing ${s(j.job_number)}`, qty: 1, unit_cents: cents }];
  const gst = st.gst_registered === "1";
  const t = invoiceTotals(lines, gst);
  const num = await nextNumber(c.env, "invoice");
  const row = await c.env.DB.prepare(
    `INSERT INTO invoices (number, job_id, client_id, issued_on, due_on, lines_json, gst_registered, subtotal_cents, gst_cents, total_cents) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).bind(num, jobId, j.client_id ?? null, issued, addDays(issued, Number(st.payment_terms_days || 14)), JSON.stringify(lines), gst ? 1 : 0, t.subtotal_cents, t.gst_cents, t.total_cents).first<{ id: number }>();
  await c.env.DB.prepare(`UPDATE jobs SET status='invoiced' WHERE id=? AND status <> 'done'`).bind(jobId).run();
  return redirect(`/invoices/${row!.id}`, `Invoice ${num} created as a draft.`);
}

async function invoicesPage(c: Ctx): Promise<Response> {
  const { results } = await c.env.DB.prepare(
    `SELECT i.*, c.name AS client_name, j.job_number FROM invoices i LEFT JOIN clients c ON c.id=i.client_id LEFT JOIN jobs j ON j.id=i.job_id
      WHERE i.deleted_at IS NULL ORDER BY i.id DESC`,
  ).all<Row>();
  const today = todayBrisbane();
  const owing = results.filter((i) => i.status !== "paid").reduce((a, i) => a + n(i.total_cents), 0);
  const rows = results.map((i) => [
    `<a href="/invoices/${i.id}"><b>${esc(i.number)}</b></a>`,
    i.job_id ? `<a href="/jobs/${i.job_id}">${esc(i.job_number)}</a>` : "",
    esc(i.client_name),
    esc(i.issued_on),
    `${esc(i.due_on)}${i.status !== "paid" && s(i.due_on) < today ? ` ${badge("Overdue", "bad")}` : ""}`,
    `<span class="num">${formatDollars(n(i.total_cents))}</span>`,
    statusBadge(s(i.status)),
    iconBtn({ icon: "eye", label: `Open invoice ${s(i.number)}`, href: `/invoices/${i.id}` }) +
      iconBtn({ icon: "printer", label: `Print or save ${s(i.number)} as PDF`, href: `/invoices/${i.id}?print=1` }) +
      iconBtn({ icon: "bin", label: `Delete invoice ${s(i.number)}`, dialog: `del-inv-${i.id}`, danger: true }),
  ]);
  const dlgs = results.map((i) => confirmDelete(`del-inv-${i.id}`, `invoice ${s(i.number)}`, `/invoices/${i.id}/delete`)).join("");
  const body = `<div class="bar"><h1>Invoices</h1></div>
    <p class="sub">Create an invoice from a job (the ${icon("receipt")} button on the job). Outstanding: <b>${formatDollars(owing)}</b>.</p>
    ${table(["Invoice", "Job", "Client", "Issued", "Due", "Total", "Status", "Actions"], rows, "No invoices yet.")}${dlgs}`;
  return layout({ title: "Invoices", path: c.url.pathname, email: c.email, body, flash: flashOf(c.url) });
}

async function invoicePage(c: Ctx, id: number): Promise<Response> {
  const i = await c.env.DB.prepare(
    `SELECT i.*, c.name AS client_name, c.contact AS client_contact, c.email AS client_email, c.address AS client_address, c.logo_key, j.job_number, j.project, j.site_address
       FROM invoices i LEFT JOIN clients c ON c.id=i.client_id LEFT JOIN jobs j ON j.id=i.job_id WHERE i.id=? AND i.deleted_at IS NULL`,
  ).bind(id).first<Row>();
  if (!i) return notFound(c, "invoice");
  const st = await settings(c.env);
  const lines = JSON.parse(s(i.lines_json)) as InvoiceLine[];
  const gst = n(i.gst_registered) === 1;
  const lineRows = lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${formatDollars(l.unit_cents)}</td><td class="num">${formatDollars(Math.round(l.qty * l.unit_cents))}</td></tr>`).join("");
  const linesText = lines.map((l) => `${l.description} | ${(l.unit_cents / 100).toFixed(2)}${l.qty !== 1 ? ` | ${l.qty}` : ""}`).join("\n");
  const doc = `<article class="invoice">
    <header><div><h1 style="margin:0">${gst ? "Tax invoice" : "Invoice"}</h1><div class="muted">${esc(i.number)}</div></div>
      <div style="text-align:right"><b>${esc(st.business_name)}</b>${st.abn ? `<div>ABN ${esc(st.abn)}</div>` : ""}
      ${st.address ? `<div class="pre">${esc(st.address)}</div>` : ""}${st.email ? `<div>${esc(st.email)}</div>` : ""}${st.phone ? `<div>${esc(st.phone)}</div>` : ""}</div></header>
    <section class="meta"><div><div class="muted small">Bill to</div><b>${esc(i.client_name) || "—"}</b>${i.client_contact ? `<div>${esc(i.client_contact)}</div>` : ""}${i.client_address ? `<div class="pre">${esc(i.client_address)}</div>` : ""}${i.client_email ? `<div>${esc(i.client_email)}</div>` : ""}</div>
      <dl><dt>Invoice date</dt><dd>${esc(i.issued_on)}</dd><dt>Due date</dt><dd>${esc(i.due_on)}</dd>${i.job_number ? `<dt>Job</dt><dd>${esc(i.job_number)}</dd>` : ""}</dl></section>
    <table class="lines"><thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead><tbody>${lineRows}</tbody></table>
    <dl class="totals"><dt>Subtotal</dt><dd>${formatDollars(n(i.subtotal_cents))}</dd>${gst ? `<dt>GST (10%)</dt><dd>${formatDollars(n(i.gst_cents))}</dd>` : ""}<dt class="grand">Total${gst ? " (incl. GST)" : ""}</dt><dd class="grand">${formatDollars(n(i.total_cents))}</dd></dl>
    ${gst ? "" : `<p class="small muted">No GST has been charged.</p>`}
    ${st.payment_details ? `<section><div class="muted small">Payment details</div><div class="pre">${esc(st.payment_details)}</div></section>` : ""}
    ${i.notes ? `<section><div class="pre">${esc(i.notes)}</div></section>` : ""}
  </article>`;
  const invCss = `<style>.invoice{background:#fff;color:#111;border:1px solid var(--line);border-radius:12px;padding:32px;max-width:800px;margin:16px auto}
    .invoice header,.invoice .meta{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-bottom:24px}.invoice .muted{color:#666}
    .invoice .pre{white-space:pre-line}.invoice dl{display:grid;grid-template-columns:auto auto;gap:2px 16px;margin:0}.invoice dt{color:#666}.invoice dd{margin:0;text-align:right}
    .invoice table.lines{width:100%;border-collapse:collapse;margin:8px 0 16px}.invoice table.lines th{background:#f3f5f0;color:#444}.invoice table.lines td,.invoice table.lines th{border-bottom:1px solid #e3e6df;padding:8px;display:table-cell}
    .invoice table.lines thead{display:table-header-group}.invoice table.lines tr{display:table-row}.invoice table.lines td::before{content:none}
    .invoice .num{text-align:right;font-variant-numeric:tabular-nums}.invoice .totals{margin-left:auto;width:max-content;margin-bottom:24px}.invoice .grand{font-weight:700;font-size:17px;color:#111}
    @media print{.invoice{border:0;margin:0;padding:0;max-width:none}}</style>`;
  const autoPrint = c.url.searchParams.get("print") === "1" ? `<script>addEventListener("load",function(){print()})</script>` : "";
  const body = `<div class="bar noprint"><h1>Invoice ${esc(i.number)}</h1>${statusBadge(s(i.status))}
      ${iconBtn({ icon: "pencil", label: "Edit invoice", dialog: "edit-inv" })}
      ${iconBtn({ icon: "printer", label: "Print or save as PDF", attrs: 'onclick="print()" type="button"' }).replace('type="submit" ', "")}
      ${iconBtn({ icon: "bin", label: "Delete invoice", dialog: "del-inv", danger: true })}</div>
    ${invCss}${doc}
    ${formDialog("edit-inv", `Edit ${esc(i.number)}`, `/invoices/${id}`, `${pills("status", "Status", INVOICE_STATUSES, s(i.status))}
      ${field("issued_on", "Invoice date", s(i.issued_on), { type: "date" })}${field("due_on", "Due date", s(i.due_on), { type: "date" })}
      ${area("lines", "Lines", linesText, { rows: 4, hint: "One line each: description | amount | quantity (quantity is optional, default 1)." })}
      ${area("notes", "Notes on the invoice", s(i.notes), { rows: 2 })}`)}
    ${confirmDelete("del-inv", `invoice ${s(i.number)}`, `/invoices/${id}/delete`)}${autoPrint}`;
  return layout({ title: `Invoice ${s(i.number)}`, path: c.url.pathname, email: c.email, body, flash: flashOf(c.url) });
}

export function parseLines(text: string): InvoiceLine[] | null {
  const out: InvoiceLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const [desc, amount, qty] = raw.split("|").map((x) => x.trim());
    const cents = parseDollars(amount ?? "");
    const q = qty ? Number(qty) : 1;
    if (!desc || cents === null || !Number.isFinite(q) || q <= 0) return null;
    out.push({ description: desc, qty: q, unit_cents: cents });
  }
  return out.length ? out : null;
}

async function updateInvoice(c: Ctx, id: number): Promise<Response> {
  const f = await c.req.formData();
  const inv = await c.env.DB.prepare(`SELECT gst_registered FROM invoices WHERE id=? AND deleted_at IS NULL`).bind(id).first<Row>();
  if (!inv) return notFound(c, "invoice");
  const lines = parseLines(s(f.get("lines")));
  if (!lines) return redirect(`/invoices/${id}`, "Each line needs a description and an amount, like: Drawing | 250.00", true);
  const t = invoiceTotals(lines, n(inv.gst_registered) === 1);
  const status = INVOICE_STATUSES.some(([k]) => k === s(f.get("status"))) ? s(f.get("status")) : "draft";
  const date = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s(f.get(k))) ? s(f.get(k)) : null);
  await c.env.DB.prepare(
    `UPDATE invoices SET status=?, issued_on=COALESCE(?, issued_on), due_on=COALESCE(?, due_on), lines_json=?, subtotal_cents=?, gst_cents=?, total_cents=?, notes=? WHERE id=?`,
  ).bind(status, date("issued_on"), date("due_on"), JSON.stringify(lines), t.subtotal_cents, t.gst_cents, t.total_cents, s(f.get("notes")).trim(), id).run();
  return redirect(`/invoices/${id}`, "Invoice saved.");
}

// ---------- Settings ----------

const SETTING_FIELDS = ["business_name", "abn", "email", "phone", "address", "payment_terms_days", "payment_details", "drawn_by", "default_disclaimer", "job_prefix", "invoice_prefix"];

async function settingsPage(c: Ctx): Promise<Response> {
  const [st, tiers] = await Promise.all([settings(c.env), tiersList(c.env)]);
  const nextJob = formatNumber(st.job_prefix, Number(st.job_next), Number(st.job_pad));
  const nextInv = formatNumber(st.invoice_prefix, Number(st.invoice_next), Number(st.invoice_pad));
  const tierRows = tiers.map((t) => [`<b>${esc(t.name)}</b>`, esc(t.description), `<span class="num">${n(t.price_cents) ? formatDollars(n(t.price_cents)) : '<span class="muted">Not set</span>'}</span>`,
    iconBtn({ icon: "pencil", label: `Edit ${s(t.name)}`, dialog: `edit-tier-${t.id}` }) + iconBtn({ icon: "bin", label: `Delete ${s(t.name)}`, dialog: `del-tier-${t.id}`, danger: true })]);
  const tierDlgs = tiers.map((t) => formDialog(`edit-tier-${t.id}`, `Edit ${esc(t.name)}`, `/tiers/${t.id}`, tierFields(t)) + confirmDelete(`del-tier-${t.id}`, `the ${s(t.name)} size`, `/tiers/${t.id}/delete`)).join("");
  const body = `<h1>Settings</h1>
    <div class="bar"><h2>Job sizes and prices</h2>${iconBtn({ icon: "plus", label: "Add a size", dialog: "new-tier" })}</div>
    <p class="sub">You price by the size of the job, not by the hour. Time a few practice jobs, then set a price for each size.</p>
    ${table(["Size", "What it covers", "Price (before GST)", "Actions"], tierRows, "No sizes yet.")}
    <h2>Business and invoices</h2>
    <form method="post" action="/settings" class="panel"><div class="grid">
      ${field("business_name", "Business name", st.business_name, { required: true })}${field("abn", "ABN", st.abn, { attrs: 'inputmode="numeric"' })}
      ${field("email", "Email", st.email, { type: "email" })}${field("phone", "Phone", st.phone)}
      ${area("address", "Business address", st.address, { rows: 2 })}
      <div class="full">${toggle("gst_registered", "Registered for GST", st.gst_registered === "1", "When on, new invoices add 10% GST and are titled Tax invoice. Existing invoices keep their GST setting.")}</div>
      ${field("payment_terms_days", "Payment terms (days)", st.payment_terms_days, { type: "number", attrs: 'min="0" max="120"' })}
      ${field("drawn_by", "Drawn by (title block)", st.drawn_by)}
      ${area("payment_details", "Payment details", st.payment_details, { rows: 3, hint: "Bank name, BSB and account number, printed on every invoice." })}
      ${area("default_disclaimer", "Default disclaimer", st.default_disclaimer, { rows: 2, hint: "Used on title blocks when the client has no disclaimer of their own." })}
      ${field("job_prefix", "Job number prefix", st.job_prefix, { hint: `Next job: <b>${esc(nextJob)}</b>` })}
      ${field("job_next", "Next job number", st.job_next, { type: "number", attrs: 'min="1"' })}
      ${field("invoice_prefix", "Invoice number prefix", st.invoice_prefix, { hint: `Next invoice: <b>${esc(nextInv)}</b>` })}
      ${field("invoice_last", "Carry on from your last invoice", "", { hint: "Type your last paper invoice number (e.g. INV-0042) and the next one becomes INV-0043. Leave blank to keep the current series." })}
    </div><div class="btns"><button class="btn btn-primary">Save settings</button></div></form>
    ${formDialog("new-tier", "Add a size", "/tiers", tierFields({}), "Add")}${tierDlgs}`;
  return layout({ title: "Settings", path: c.url.pathname, email: c.email, body, flash: flashOf(c.url) });
}

const tierFields = (t: Row) => `${field("name", "Size name", s(t.name), { required: true })}
  ${field("price", "Price (AUD, before GST)", n(t.price_cents) ? (n(t.price_cents) / 100).toFixed(2) : "", { attrs: 'inputmode="decimal" placeholder="0.00"' })}
  ${area("description", "What it covers", s(t.description), { rows: 2 })}${field("sort", "Order", s(t.sort ?? 0), { type: "number" })}`;

async function saveSettings(c: Ctx): Promise<Response> {
  const f = await c.req.formData();
  const stmts = SETTING_FIELDS.map((k) => c.env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(k, s(f.get(k)).trim()));
  stmts.push(c.env.DB.prepare(`UPDATE settings SET value=? WHERE key='gst_registered'`).bind(f.get("gst_registered") === "1" ? "1" : "0"));
  const jobNext = Number(s(f.get("job_next")));
  if (Number.isInteger(jobNext) && jobNext > 0) stmts.push(c.env.DB.prepare(`UPDATE settings SET value=? WHERE key='job_next'`).bind(String(jobNext)));
  const last = s(f.get("invoice_last")).trim();
  if (last) {
    const cont = continueFrom(last);
    if (!cont) return redirect("/settings", `"${last}" has no number at the end to carry on from.`, true);
    stmts.push(
      c.env.DB.prepare(`UPDATE settings SET value=? WHERE key='invoice_prefix'`).bind(cont.prefix),
      c.env.DB.prepare(`UPDATE settings SET value=? WHERE key='invoice_next'`).bind(String(cont.next)),
      c.env.DB.prepare(`UPDATE settings SET value=? WHERE key='invoice_pad'`).bind(String(cont.pad)),
    );
  }
  await c.env.DB.batch(stmts);
  return redirect("/settings", "Settings saved.");
}

async function saveTier(c: Ctx, id: number | null): Promise<Response> {
  const f = await c.req.formData();
  const name = s(f.get("name")).trim();
  const priceText = s(f.get("price")).trim();
  const price = priceText ? parseDollars(priceText) : 0;
  if (!name || price === null) return redirect("/settings", "Give the size a name and a price like 250.00.", true);
  const sort = Number(s(f.get("sort"))) || 0;
  if (id === null) await c.env.DB.prepare(`INSERT INTO size_tiers (name, description, price_cents, sort) VALUES (?,?,?,?)`).bind(name, s(f.get("description")).trim(), price, sort).run();
  else await c.env.DB.prepare(`UPDATE size_tiers SET name=?, description=?, price_cents=?, sort=? WHERE id=?`).bind(name, s(f.get("description")).trim(), price, sort, id).run();
  return redirect("/settings", `${name} saved.`);
}

// ---------- Router ----------

async function softDelete(env: Env, table: string, id: number) {
  await env.DB.prepare(`UPDATE ${table} SET deleted_at=datetime('now') WHERE id=? AND deleted_at IS NULL`).bind(id).run();
}

/** Rejects cross-site form posts (Access cookies would otherwise ride along). */
function sameOrigin(req: Request, url: URL): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === url.origin;
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

export async function route(c: Ctx): Promise<Response> {
  const { env, req, url } = c;
  const p = url.pathname;
  const m = (re: RegExp) => re.exec(p);
  let r: RegExpExecArray | null;

  if (req.method === "GET") {
    if (p === "/") return jobsPage(c);
    if ((r = m(/^\/jobs\/(\d+)$/))) return jobPage(c, +r[1]);
    if ((r = m(/^\/jobs\/(\d+)\/title-block\.(csv|xml)$/))) {
      const tb = await titleBlockFor(env, +r[1]);
      if (!tb) return notFound(c, "job");
      return r[2] === "csv"
        ? download(titleBlockCsv(tb), `${tb.job_number}-title-block.csv`, "text/csv; charset=utf-8")
        : download(titleBlockXml(tb), `${tb.job_number}-title-block.xml`, "application/xml; charset=utf-8");
    }
    if ((r = m(/^\/jobs\/(\d+)\/checklist\.csv$/))) return checklistCsv(c, +r[1], false);
    if ((r = m(/^\/jobs\/(\d+)\/plants\.csv$/))) return checklistCsv(c, +r[1], true);
    if ((r = m(/^\/files\/(\d+)$/))) {
      const f = await env.DB.prepare(`SELECT * FROM plan_files WHERE id=? AND deleted_at IS NULL`).bind(+r[1]).first<Row>();
      return f ? serveObject(env, s(f.r2_key), s(f.filename), s(f.mime)) : notFound(c, "file");
    }
    if ((r = m(/^\/symbols\/(\d+)$/))) {
      const sy = await env.DB.prepare(`SELECT * FROM plant_symbols WHERE id=? AND deleted_at IS NULL`).bind(+r[1]).first<Row>();
      if (!sy) return notFound(c, "plant");
      const res = await serveObject(env, sy.r2_key ? s(sy.r2_key) : null, s(sy.filename), s(sy.mime));
      if (url.searchParams.get("download") === "1" && res.ok) res.headers.set("content-disposition", `attachment; filename="${s(sy.filename).replace(/[^\w.-]+/g, "_")}"`);
      return res;
    }
    if ((r = m(/^\/logos\/(\d+)$/))) {
      const cl = await env.DB.prepare(`SELECT logo_key FROM clients WHERE id=? AND deleted_at IS NULL`).bind(+r[1]).first<Row>();
      const obj = cl?.logo_key && env.FILES ? await env.FILES.head(s(cl.logo_key)) : null;
      return serveObject(env, cl?.logo_key ? s(cl.logo_key) : null, "logo", obj?.httpMetadata?.contentType ?? "image/png");
    }
    if (p === "/plants") return plantsPage(c);
    if (p === "/clients") return clientsPage(c);
    if (p === "/invoices") return invoicesPage(c);
    if ((r = m(/^\/invoices\/(\d+)$/))) return invoicePage(c, +r[1]);
    if (p === "/settings") return settingsPage(c);
    return notFound(c);
  }

  if (req.method === "POST") {
    if (!sameOrigin(req, url)) return new Response("Cross-site request refused.", { status: 403 });
    if (p === "/jobs") return createJob(c);
    if ((r = m(/^\/jobs\/(\d+)$/))) return updateJob(c, +r[1]);
    if ((r = m(/^\/jobs\/(\d+)\/delete$/))) { await softDelete(env, "jobs", +r[1]); return redirect("/", "Job deleted."); }
    if ((r = m(/^\/jobs\/(\d+)\/files$/))) return uploadFiles(c, +r[1]);
    if ((r = m(/^\/jobs\/(\d+)\/invoice$/))) return createInvoiceFromJob(c, +r[1]);
    if ((r = m(/^\/jobs\/(\d+)\/items$/))) {
      const v = itemValues(await req.formData());
      if (!v.label) return redirect(`/jobs/${r[1]}`, "The item needs some text.", true);
      if (!(await getJob(env, +r[1]))) return notFound(c, "job");
      await env.DB.prepare(`INSERT INTO checklist_items (job_id, kind, label, detail, quantity, source, sort) VALUES (?,?,?,?,?, 'manual', 1000)`).bind(+r[1], v.kind, v.label, v.detail, v.quantity).run();
      return redirect(`/jobs/${r[1]}`, "Item added.");
    }
    if ((r = m(/^\/files\/(\d+)\/read$/))) return readFile(c, +r[1]);
    if ((r = m(/^\/files\/(\d+)\/delete$/))) {
      const f = await env.DB.prepare(`SELECT job_id FROM plan_files WHERE id=?`).bind(+r[1]).first<{ job_id: number }>();
      await softDelete(env, "plan_files", +r[1]);
      return redirect(f ? `/jobs/${f.job_id}` : "/", "File deleted. Its checklist items are kept.");
    }
    if ((r = m(/^\/items\/(\d+)\/done$/))) {
      const it = await itemJob(env, +r[1]);
      if (!it) return notFound(c, "item");
      const done = (await req.formData()).get("done") === "1" ? 1 : 0;
      await env.DB.prepare(`UPDATE checklist_items SET done=? WHERE id=?`).bind(done, +r[1]).run();
      return redirect(`/jobs/${it.job_id}`);
    }
    if ((r = m(/^\/items\/(\d+)\/delete$/))) {
      const it = await itemJob(env, +r[1]);
      if (!it) return notFound(c, "item");
      await softDelete(env, "checklist_items", +r[1]);
      return redirect(`/jobs/${it.job_id}`, "Item deleted.");
    }
    if ((r = m(/^\/items\/(\d+)$/))) {
      const it = await itemJob(env, +r[1]);
      if (!it) return notFound(c, "item");
      const v = itemValues(await req.formData());
      if (!v.label) return redirect(`/jobs/${it.job_id}`, "The item needs some text.", true);
      await env.DB.prepare(`UPDATE checklist_items SET kind=?, label=?, detail=?, quantity=? WHERE id=?`).bind(v.kind, v.label, v.detail, v.quantity, +r[1]).run();
      return redirect(`/jobs/${it.job_id}`, "Item saved.");
    }
    if (p === "/plants") return savePlant(c, null);
    if ((r = m(/^\/plants\/(\d+)\/delete$/))) { await softDelete(env, "plant_symbols", +r[1]); return redirect("/plants", "Plant deleted."); }
    if ((r = m(/^\/plants\/(\d+)$/))) return savePlant(c, +r[1]);
    if (p === "/clients") return saveClient(c, null);
    if ((r = m(/^\/clients\/(\d+)\/delete$/))) { await softDelete(env, "clients", +r[1]); return redirect("/clients", "Client deleted."); }
    if ((r = m(/^\/clients\/(\d+)$/))) return saveClient(c, +r[1]);
    if ((r = m(/^\/invoices\/(\d+)\/delete$/))) { await softDelete(env, "invoices", +r[1]); return redirect("/invoices", "Invoice deleted. Its number is not reused."); }
    if ((r = m(/^\/invoices\/(\d+)$/))) return updateInvoice(c, +r[1]);
    if (p === "/settings") return saveSettings(c);
    if (p === "/tiers") return saveTier(c, null);
    if ((r = m(/^\/tiers\/(\d+)\/delete$/))) { await softDelete(env, "size_tiers", +r[1]); return redirect("/settings", "Size deleted."); }
    if ((r = m(/^\/tiers\/(\d+)$/))) return saveTier(c, +r[1]);
    return notFound(c);
  }
  return new Response("Method not allowed", { status: 405 });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext & { access?: AccessContext }): Promise<Response> {
    const host = new URL(req.url).hostname;
    const local = !!env.DEV_ACCESS_EMAIL && (host === "localhost" || host === "127.0.0.1");
    const auth = local ? { ok: true as const, email: env.DEV_ACCESS_EMAIL! } : await verifyAccess(req, env, ctx.access);
    if (!auth.ok) return new Response(auth.reason, { status: auth.status, headers: { "content-type": "text/plain; charset=utf-8" } });
    try {
      return await route({ env, req, url: new URL(req.url), email: auth.email });
    } catch (e) {
      console.error(e);
      return new Response("Something went wrong. Please try again.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  },
} satisfies ExportedHandler<Env>;
