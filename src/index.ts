// Sprigboard: Jamie's landscape-plan studio.
// Jobs register, plan reading with Claude, plant library matching, title-block
// export for Illustrator, size-tier pricing and invoices.
// Sign-in is Sprigboard's own (src/auth.ts): no Cloudflare account needed.

import { accountPage, accountPost, authRoute, currentUser, rateLimit, usersPage, usersPost, type AuthEnv, type User } from "./auth";
import { passkeyAccountRoute, passkeyLoginRoute } from "./passkeys";
import { mailEnabled, sendMail } from "./mail";
import { D1_MAX_BYTES, getBytes, getFile, maxUpload, putFile, sizeLabel, StorageError } from "./storage";
import { extractPlan, ExtractionError, isSupportedPlan, ITEM_KINDS } from "./extract";
import {
  addDays, brisbaneTime, continueFrom, formatMinutes, minutesBetween, normalisePlant, parseDuration, plantRowsFromCsv, esc, formatDollars, formatNumber, invoiceTotals, matchSymbol, parseDollars,
  titleBlockCsv, titleBlockXml, toCsv, todayBrisbane, type InvoiceLine, type Symbol, type TitleBlock,
} from "./lib";
import {
  area, badge, confirmDelete, dialog, field, formDialog, icon, iconBtn, layout, pills, select, table, toggle,
} from "./ui";

export interface Env extends AuthEnv {
  /** R2 bucket for plans, plant graphics and logos. Optional until R2 is turned on in the account. */
  FILES?: R2Bucket;
  ANTHROPIC_API_KEY?: string;
}

type Row = Record<string, unknown>;
type Ctx = { env: Env; req: Request; url: URL; user: User };

const JOB_STATUSES: [string, string][] = [["new", "New"], ["drawing", "Drawing"], ["sent", "Sent to client"], ["invoiced", "Invoiced"], ["done", "Done"]];
const INVOICE_STATUSES: [string, string][] = [["draft", "Draft"], ["sent", "Sent"], ["paid", "Paid"]];
const KIND_NAMES: Record<string, string> = { plant: "Plant", street: "Street", dimension: "Dimension", marking: "Marking", note: "Note" };
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
  return layout({ title: "Not found", path: c.url.pathname, user: c.user, status: 404, body: `<h1>Not found</h1><p class="sub">That ${esc(what)} doesn't exist or was deleted.</p><a class="btn" href="/">Back to jobs</a>` });
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

async function serveObject(env: Env, key: string | null, filename: string, mime?: string): Promise<Response> {
  if (!key) return new Response("Not found", { status: 404 });
  const obj = await getFile(env, key);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(obj.body, {
    headers: {
      "content-type": mime || obj.mime || "application/octet-stream",
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
  const q = (c.url.searchParams.get("q") ?? "").trim().slice(0, 100);
  const status = c.url.searchParams.get("status") ?? "";
  const conds: string[] = [];
  const args: unknown[] = [];
  if (JOB_STATUSES.some(([k]) => k === status)) { conds.push("j.status = ?"); args.push(status); }
  else if (show !== "all") conds.push("j.status <> 'done'");
  if (q) {
    // Escape LIKE wildcards in what Jamie typed so "50%" searches for "50%".
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(`(${["j.job_number", "j.project", "j.site_address", "c.name", "j.scope"].map((col) => `${col} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    args.push(like, like, like, like, like);
  }
  const where = conds.map((x) => `AND ${x}`).join(" ");
  const { results } = await c.env.DB.prepare(
    `SELECT j.*, c.name AS client_name, t.name AS tier_name,
            (SELECT COUNT(*) FROM plan_files f WHERE f.job_id = j.id AND f.deleted_at IS NULL) AS files,
            (SELECT COUNT(*) FROM checklist_items i WHERE i.job_id = j.id AND i.deleted_at IS NULL) AS items,
            (SELECT COUNT(*) FROM checklist_items i WHERE i.job_id = j.id AND i.deleted_at IS NULL AND i.done = 1) AS done_items
       FROM jobs j LEFT JOIN clients c ON c.id = j.client_id LEFT JOIN size_tiers t ON t.id = j.tier_id
      WHERE j.deleted_at IS NULL ${where} ORDER BY j.id DESC LIMIT 500`,
  ).bind(...args).all<Row>();
  const [clients, tiers] = await Promise.all([clientsList(c.env), tiersList(c.env)]);
  const owing = await c.env.DB.prepare(`SELECT COALESCE(SUM(total_cents),0) AS t, COUNT(*) AS n FROM invoices WHERE deleted_at IS NULL AND status <> 'paid'`).first<{ t: number; n: number }>();
  const counts = await c.env.DB.prepare(`SELECT status, COUNT(*) AS n FROM jobs WHERE deleted_at IS NULL GROUP BY status`).all<{ status: string; n: number }>();
  const count = (k: string) => counts.results.find((r) => r.status === k)?.n ?? 0;
  const filtered = !!q || !!status;
  const onboarding = await gettingStarted(c);
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
    ${iconBtn({ icon: "plus", label: "New job", dialog: "new-job", attrs: 'style="width:38px;height:38px"' }).replace('class="ib"', 'class="ib primary"')}</div>
    <p class="sub">Each job gets the next job number. Upload the plan, let Claude read it, then tick items off as you draw.</p>
    ${onboarding}
    <div class="stats"><a class="stat" href="/?status=new"><b>${count("new")}</b><span>New</span></a><a class="stat" href="/?status=drawing"><b>${count("drawing")}</b><span>Drawing</span></a>
      <a class="stat" href="/?status=sent"><b>${count("sent")}</b><span>Sent to client</span></a><a class="stat" href="/invoices"><b>${formatDollars(owing?.t ?? 0)}</b><span>${owing?.n ?? 0} invoice${owing?.n === 1 ? "" : "s"} unpaid</span></a></div>
    <form class="filters" method="get" action="/" role="search">
      <label class="fld"><span class="sr">Search jobs</span><input type="search" name="q" value="${esc(q)}" placeholder="Search job number, project, address or client"></label>
      <label class="fld"><span class="sr">Status</span><select name="status"><option value="">${show === "all" ? "All statuses" : "Open jobs"}</option>${JOB_STATUSES.map(([k, t]) => `<option value="${k}"${k === status ? " selected" : ""}>${t}</option>`).join("")}</select></label>
      ${show === "all" ? '<input type="hidden" name="show" value="all">' : ""}
      <button class="btn">Search</button>${filtered ? '<a class="btn" href="/">Clear</a>' : ""}
      <a class="btn plain" href="/?show=${show === "all" ? "open" : "all"}${q ? `&q=${encodeURIComponent(q)}` : ""}">${show === "all" ? "Hide done jobs" : "Show done jobs"}</a></form>
    ${table(["Job", "Project and site", "Client", "Size", "Checklist", "Status", "Actions"], rows, filtered ? "No jobs match. Try a different search." : "No jobs yet. Press + to add the first one.")}
    ${formDialog("new-job", "New job", "/jobs", jobFields({}, clients, tiers), "Create job")}${dels}`;
  return layout({ title: "Jobs", path: c.url.pathname, user: c.user, body, flash: flashOf(c.url) });
}

function statusBadge(st: string, kind: "job" | "invoice" = "job"): string {
  const name = (kind === "invoice" ? INVOICE_STATUSES : JOB_STATUSES).find(([k]) => k === st)?.[1] ?? st;
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
  const times = (await c.env.DB.prepare(`SELECT t.*, u.name AS user_name, u.email AS user_email FROM time_entries t LEFT JOIN users u ON u.id = t.user_id WHERE t.job_id=? AND t.deleted_at IS NULL ORDER BY t.started_at DESC`).bind(id).all<Row>()).results;
  const running = times.find((t) => !t.ended_at && n(t.user_id) === c.user.id);
  const totalMin = times.reduce((a, t) => a + (t.ended_at ? n(t.minutes) : minutesBetween(s(t.started_at), new Date().toISOString().replace("T", " ").slice(0, 19))), 0);
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
    `<a href="/invoices/${iv.id}">${esc(iv.number)}</a>`, esc(iv.issued_on), `<span class="num">${formatDollars(n(iv.total_cents))}</span>`, statusBadge(s(iv.status), "invoice"),
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
    ${c.env.FILES ? "" : `<p class="small muted">Plans up to ${sizeLabel(D1_MAX_BYTES)} can be uploaded now; bigger PDFs need R2 storage, which isn't turned on in the Cloudflare account yet.</p>`}
    ${hasKey ? "" : `<div class="flash err">Plan reading is off until the Claude API key is added (see SETUP in the repo). Everything else works.</div>`}
    <div class="flash" id="reading" hidden>Claude is reading the plan. This can take a minute or two for a detailed PDF; keep this page open.</div>
    ${table(["File", "Size", "Read", "Actions"], fileRows, "No plan uploaded yet.")}
    <div class="bar"><h2>Checklist</h2>
      ${iconBtn({ icon: "plus", label: "Add an item by hand", dialog: "new-item" })}
      ${items.length ? iconBtn({ icon: "download", label: "Checklist as CSV", href: `/jobs/${id}/checklist.csv`, download: true }) : ""}
      ${items.some((i) => i.kind === "plant") ? iconBtn({ icon: "leaf", label: "Plant list with matched symbols (CSV)", href: `/jobs/${id}/plants.csv`, download: true }) : ""}</div>
    <p class="sub small">Claude drafts this list from the plan. Check each item against the plan as you draw it; you have the final say.</p>
    ${itemTableStyled}
    <div class="bar"><h2>Time</h2>
      ${running ? `<span class="timer"><span class="dot" aria-hidden="true"></span>Timing: <span data-since="${esc(running.started_at)}">${formatMinutes(minutesBetween(s(running.started_at), new Date().toISOString().replace("T", " ").slice(0, 19)))}</span></span>
        <form method="post" action="/jobs/${id}/timer/stop" class="inline">${iconBtn({ icon: "stop", label: "Stop the timer", attrs: 'class="ib primary"' }).replace('class="ib" ', "")}</form>`
        : `<form method="post" action="/jobs/${id}/timer/start" class="inline">${iconBtn({ icon: "play", label: "Start timing this job" })}</form>`}
      ${iconBtn({ icon: "clock", label: "Add time by hand", dialog: "add-time" })}</div>
    <p class="sub small">Time spent so far: <b>${formatMinutes(totalMin)}</b>. You don't charge by the hour; this helps set your size prices (see Settings).</p>
    ${times.length ? table(["When", "Who", "Time", "Note", "Actions"], times.map((t) => [
      esc(brisbaneTime(s(t.started_at))), esc(s(t.user_name) || s(t.user_email)),
      t.ended_at ? formatMinutes(n(t.minutes)) : `<span class="timer"><span class="dot" aria-hidden="true"></span><span data-since="${esc(t.started_at)}">running</span></span>`,
      esc(t.note),
      iconBtn({ icon: "bin", label: "Delete this time entry", dialog: `del-time-${t.id}`, danger: true }),
    ]), "") : ""}
    ${times.map((t) => confirmDelete(`del-time-${t.id}`, "this time entry", `/time/${t.id}/delete`)).join("")}
    ${formDialog("add-time", "Add time by hand", `/jobs/${id}/time`, `${field("duration", "Time spent", "", { required: true, hint: "e.g. 90, 1:30 or 1.5h", attrs: 'autocomplete="off"' })}${field("date", "Date", todayBrisbane(), { type: "date" })}${field("note", "Note", "", { full: true })}`, "Add")}
    ${invoices.length ? `<h2>Invoices</h2>${table(["Invoice", "Issued", "Total", "Status", "Actions"], invRows, "")}` : ""}
    ${formDialog("edit-job", `Edit ${esc(j.job_number)}`, `/jobs/${id}`, jobFields(j, clients, tiers))}
    ${confirmDelete("del-job", `job ${s(j.job_number)}`, `/jobs/${id}/delete`)}
    ${formDialog("upload", "Upload plan files", `/jobs/${id}/files`, `<label class="fld full"><span>Plan files</span><input type="file" name="files" multiple required accept="application/pdf,image/jpeg,image/png,image/webp,image/gif"><small>PDF, JPEG or PNG, up to 30 MB each.</small></label>`, "Upload", "multipart/form-data")}
    ${formDialog("new-item", "Add checklist item", `/jobs/${id}/items`, itemFields({ kind: "plant" }, kinds), "Add")}
    ${formDialog("new-invoice", `Invoice for ${esc(j.job_number)}`, `/jobs/${id}/invoice`, invoiceFromJobFields(j, st), "Create invoice")}
    ${itemDialogs}${fileDialogs}`;
  return layout({ title: s(j.job_number), path: c.url.pathname, user: c.user, body, flash: flashOf(c.url) });
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
    <div class="full">${toggle("add_gst", "Add GST (10%)", st.gst_on_invoices === "1", gstHint(st))}</div>
    <p class="small muted full">The invoice gets the next number and is saved as a draft.</p>`;
}

// ---------- Plan files ----------

async function uploadFiles(c: Ctx, jobId: number): Promise<Response> {
  if (!(await getJob(c.env, jobId))) return notFound(c, "job");
  const form = await c.req.formData();
  const files = form.getAll("files").filter((f): f is File => typeof f !== "string" && f.size > 0);
  if (!files.length) return redirect(`/jobs/${jobId}`, "Choose at least one file.", true);
  const skipped: string[] = [];
  const max = maxUpload(c.env, MAX_UPLOAD);
  for (const f of files) {
    if (f.size > max) { skipped.push(`${f.name} (over ${sizeLabel(max)}${c.env.FILES ? "" : "; bigger files need R2 storage, not turned on yet"})`); continue; }
    const mime = f.type || "application/octet-stream";
    const key = fileKey(`plans/${jobId}`, f.name);
    await putFile(c.env, key, f, mime);
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
  const obj = await getBytes(c.env, s(f.r2_key));
  if (!obj) return redirect(`/jobs/${jobId}`, "The stored file is missing.", true);
  try {
    const result = await extractPlan(c.env.ANTHROPIC_API_KEY, { mime: s(f.mime), bytes: obj.bytes }, s(f.filename));
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
  const body = `<div class="bar"><h1>Plant library</h1>${iconBtn({ icon: "upload", label: "Import plants from a CSV file", dialog: "import-plants" })}${iconBtn({ icon: "download", label: "Download the plant list (CSV)", href: "/plants.csv", download: true })}${iconBtn({ icon: "plus", label: "Add a plant", dialog: "new-plant" }).replace('class="ib"', 'class="ib primary"')}</div>
    <p class="sub">Your plant graphics. Checklist plants are matched by code, then botanical or common name, then genus and species.</p>
    ${table(["Symbol", "Botanical name", "Common name", "Code", "Actions"], rows, "No plants yet. Add your plant graphics so jobs can match them.")}
    ${formDialog("new-plant", "Add a plant", "/plants", plantFields({}), "Add", "multipart/form-data")}
    ${formDialog("import-plants", "Import plants", "/plants/import", `<label class="fld full"><span>CSV file</span><input type="file" name="file" accept=".csv,text/csv" required>
      <small>Columns: <b>botanical</b> (required), <b>common</b>, <b>code</b>. The first row is the header. Plants already in the library (same botanical name) are updated, not duplicated. Add symbol graphics afterwards with the pencil.</small></label>`, "Import", "multipart/form-data")}${dlgs}`;
  return layout({ title: "Plant library", path: c.url.pathname, user: c.user, body, flash: flashOf(c.url) });
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
    const max = maxUpload(c.env, 10 * 1024 * 1024);
    if (file.size > max) return redirect("/plants", `Symbol files can be up to ${sizeLabel(max)}${c.env.FILES ? "" : " until R2 storage is turned on"}.`, true);
    const key = fileKey("symbols", file.name);
    const mime = file.type || "application/octet-stream";
    await putFile(c.env, key, file, mime);
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
  return layout({ title: "Clients", path: c.url.pathname, user: c.user, body, flash: flashOf(c.url) });
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
    const max = maxUpload(c.env, 5 * 1024 * 1024);
    if (!isImage(logo.type) || logo.size > max) return redirect("/clients", `The logo must be an image up to ${sizeLabel(max)}.`, true);
    logoKey = fileKey("logos", logo.name);
    await putFile(c.env, logoKey, logo, logo.type);
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
  const gst = f.get("add_gst") === "1";
  const t = invoiceTotals(lines, gst);
  const num = await nextNumber(c.env, "invoice");
  const row = await c.env.DB.prepare(
    `INSERT INTO invoices (number, job_id, client_id, issued_on, due_on, lines_json, gst_registered, business_gst_registered, subtotal_cents, gst_cents, total_cents) VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
  ).bind(num, jobId, j.client_id ?? null, issued, addDays(issued, Number(st.payment_terms_days || 14)), JSON.stringify(lines), gst ? 1 : 0, st.gst_registered === "1" ? 1 : 0, t.subtotal_cents, t.gst_cents, t.total_cents).first<{ id: number }>();
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
    statusBadge(s(i.status), "invoice"),
    iconBtn({ icon: "eye", label: `Open invoice ${s(i.number)}`, href: `/invoices/${i.id}` }) +
      iconBtn({ icon: "printer", label: `Print or save ${s(i.number)} as PDF`, href: `/invoices/${i.id}?print=1` }) +
      iconBtn({ icon: "bin", label: `Delete invoice ${s(i.number)}`, dialog: `del-inv-${i.id}`, danger: true }),
  ]);
  const dlgs = results.map((i) => confirmDelete(`del-inv-${i.id}`, `invoice ${s(i.number)}`, `/invoices/${i.id}/delete`)).join("");
  const body = `<div class="bar"><h1>Invoices</h1></div>
    <p class="sub">Create an invoice from a job (the ${icon("receipt")} button on the job). Outstanding: <b>${formatDollars(owing)}</b>.</p>
    ${table(["Invoice", "Job", "Client", "Issued", "Due", "Total", "Status", "Actions"], rows, "No invoices yet.")}${dlgs}`;
  return layout({ title: "Invoices", path: c.url.pathname, user: c.user, body, flash: flashOf(c.url) });
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
  const taxInvoice = gst && n(i.business_gst_registered) === 1;
  const lineRows = lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="num">${l.qty}</td><td class="num">${formatDollars(l.unit_cents)}</td><td class="num">${formatDollars(Math.round(l.qty * l.unit_cents))}</td></tr>`).join("");
  const linesText = lines.map((l) => `${l.description} | ${(l.unit_cents / 100).toFixed(2)}${l.qty !== 1 ? ` | ${l.qty}` : ""}`).join("\n");
  const doc = `<article class="invoice">
    <header><div>${st.business_logo_key ? `<img src="/settings/logo" alt="${esc(st.business_name)}" style="max-height:64px;max-width:220px;display:block;margin-bottom:12px">` : ""}<h1 style="margin:0">${taxInvoice ? "Tax invoice" : "Invoice"}</h1><div class="muted">${esc(i.number)}</div></div>
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
  const body = `<div class="bar noprint"><h1>Invoice ${esc(i.number)}</h1>${statusBadge(s(i.status), "invoice")}
      ${iconBtn({ icon: "pencil", label: "Edit invoice", dialog: "edit-inv" })}
      ${iconBtn({ icon: "printer", label: "Print or save as PDF", attrs: 'onclick="print()" type="button"' }).replace('type="submit" ', "")}
      ${mailEnabled(c.env) && i.client_email ? iconBtn({ icon: "mail", label: `Email this invoice to ${s(i.client_email)}`, dialog: "email-inv" }) : ""}
      ${iconBtn({ icon: "bin", label: "Delete invoice", dialog: "del-inv", danger: true })}</div>
    ${invCss}${doc}
    ${formDialog("edit-inv", `Edit ${esc(i.number)}`, `/invoices/${id}`, `${pills("status", "Status", INVOICE_STATUSES, s(i.status))}
      ${field("issued_on", "Invoice date", s(i.issued_on), { type: "date" })}${field("due_on", "Due date", s(i.due_on), { type: "date" })}
      ${area("lines", "Lines", linesText, { rows: 4, hint: "One line each: description | amount | quantity (quantity is optional, default 1)." })}
      <div class="full">${toggle("add_gst", "Add GST (10%)", gst, gstHint(st, n(i.business_gst_registered) === 1))}</div>
      ${area("notes", "Notes on the invoice", s(i.notes), { rows: 2 })}`)}
    ${confirmDelete("del-inv", `invoice ${s(i.number)}`, `/invoices/${id}/delete`)}${autoPrint}
    ${dialog("email-inv", `Email ${esc(i.number)}?`, `<form method="post" action="/invoices/${id}/email">
      <p>Sends the invoice to <b>${esc(i.client_email)}</b>${st.email ? `, with replies going to ${esc(st.email)}` : ""}. A draft is marked as sent.</p>
      ${area("message", "Message (optional)", `Hi ${s(i.client_contact) || s(i.client_name)},\n\nPlease find invoice ${s(i.number)} below.\n\nThanks,\n${st.drawn_by || st.business_name}`, { rows: 5 })}
      <div class="btns"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">Send</button></div></form>`)}`;
  return layout({ title: `Invoice ${s(i.number)}`, path: c.url.pathname, user: c.user, body, flash: flashOf(c.url) });
}

/** The invoice as an email: inline styles only, so it renders in mail clients. */
function invoiceEmailHtml(i: Row, st: Record<string, string>, lines: InvoiceLine[], message: string): string {
  const gst = n(i.gst_registered) === 1;
  const taxInvoice = gst && n(i.business_gst_registered) === 1;
  const td = 'style="padding:8px;border-bottom:1px solid #e3e6df"', tdr = 'style="padding:8px;border-bottom:1px solid #e3e6df;text-align:right"';
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;padding:24px;color:#1d231c">
  ${message ? `<p style="white-space:pre-line">${esc(message)}</p><hr style="border:0;border-top:1px solid #e3e6df;margin:24px 0">` : ""}
  <table width="100%" style="border-collapse:collapse"><tr><td><h1 style="margin:0;font-size:22px">${taxInvoice ? "Tax invoice" : "Invoice"} ${esc(i.number)}</h1>
    <div style="color:#5f6b5c">Issued ${esc(i.issued_on)} · Due ${esc(i.due_on)}${i.job_number ? ` · Job ${esc(i.job_number)}` : ""}</div></td>
    <td style="text-align:right"><b>${esc(st.business_name)}</b>${st.abn ? `<br>ABN ${esc(st.abn)}` : ""}${st.email ? `<br>${esc(st.email)}` : ""}${st.phone ? `<br>${esc(st.phone)}` : ""}</td></tr></table>
  <p><span style="color:#5f6b5c">Bill to</span><br><b>${esc(i.client_name)}</b>${i.client_contact ? `<br>${esc(i.client_contact)}` : ""}</p>
  <table width="100%" style="border-collapse:collapse;margin:16px 0"><tr style="background:#f3f5f0"><th ${td} align="left">Description</th><th ${tdr}>Qty</th><th ${tdr}>Unit price</th><th ${tdr}>Amount</th></tr>
  ${lines.map((l) => `<tr><td ${td}>${esc(l.description)}</td><td ${tdr}>${l.qty}</td><td ${tdr}>${formatDollars(l.unit_cents)}</td><td ${tdr}>${formatDollars(Math.round(l.qty * l.unit_cents))}</td></tr>`).join("")}</table>
  <table style="margin-left:auto;border-collapse:collapse"><tr><td style="padding:2px 12px;color:#5f6b5c">Subtotal</td><td style="text-align:right">${formatDollars(n(i.subtotal_cents))}</td></tr>
  ${gst ? `<tr><td style="padding:2px 12px;color:#5f6b5c">GST (10%)</td><td style="text-align:right">${formatDollars(n(i.gst_cents))}</td></tr>` : ""}
  <tr><td style="padding:6px 12px;font-weight:700">Total${gst ? " (incl. GST)" : ""}</td><td style="text-align:right;font-weight:700;font-size:18px">${formatDollars(n(i.total_cents))}</td></tr></table>
  ${gst ? "" : `<p style="color:#5f6b5c;font-size:13px">No GST has been charged.</p>`}
  ${st.payment_details ? `<p><span style="color:#5f6b5c">Payment details</span><br><span style="white-space:pre-line">${esc(st.payment_details)}</span></p>` : ""}
  ${i.notes ? `<p style="white-space:pre-line">${esc(i.notes)}</p>` : ""}</div>`;
}

async function emailInvoice(c: Ctx, id: number): Promise<Response> {
  const i = await c.env.DB.prepare(
    `SELECT i.*, c.name AS client_name, c.contact AS client_contact, c.email AS client_email, j.job_number
       FROM invoices i LEFT JOIN clients c ON c.id=i.client_id LEFT JOIN jobs j ON j.id=i.job_id WHERE i.id=? AND i.deleted_at IS NULL`,
  ).bind(id).first<Row>();
  if (!i) return notFound(c, "invoice");
  if (!mailEnabled(c.env)) return redirect(`/invoices/${id}`, "Email isn't set up yet. Print or save the invoice as a PDF instead.", true);
  if (!i.client_email) return redirect(`/invoices/${id}`, "Add an email address to the client first.", true);
  if (!(await rateLimit(c.env, `invmail:${id}`, 5, 3600))) return redirect(`/invoices/${id}`, "This invoice was emailed several times in the last hour. Try again later.", true);
  const st = await settings(c.env);
  const lines = JSON.parse(s(i.lines_json)) as InvoiceLine[];
  const message = s((await c.req.formData()).get("message")).trim().slice(0, 2000);
  const gst = n(i.gst_registered) === 1;
  const taxInvoice = gst && n(i.business_gst_registered) === 1;
  const sent = await sendMail(c.env, {
    to: s(i.client_email), replyTo: st.email || undefined,
    subject: `${taxInvoice ? "Tax invoice" : "Invoice"} ${s(i.number)} from ${st.business_name}`,
    text: `${message ? message + "\n\n" : ""}${taxInvoice ? "Tax invoice" : "Invoice"} ${s(i.number)}\nIssued ${s(i.issued_on)}, due ${s(i.due_on)}\n\n${lines.map((l) => `${l.description}: ${formatDollars(Math.round(l.qty * l.unit_cents))}`).join("\n")}\n\nTotal${gst ? " (incl. GST)" : ""}: ${formatDollars(n(i.total_cents))}\n${st.payment_details ? `\nPayment details:\n${st.payment_details}\n` : ""}`,
    html: invoiceEmailHtml(i, st, lines, message),
  });
  if (!sent) return redirect(`/invoices/${id}`, "The email couldn't be sent. Try again, or print or save it as a PDF.", true);
  await c.env.DB.prepare(`UPDATE invoices SET status = CASE WHEN status='draft' THEN 'sent' ELSE status END WHERE id=?`).bind(id).run();
  return redirect(`/invoices/${id}`, `Invoice ${s(i.number)} emailed to ${s(i.client_email)}.`);
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
  const inv = await c.env.DB.prepare(`SELECT id FROM invoices WHERE id=? AND deleted_at IS NULL`).bind(id).first<Row>();
  if (!inv) return notFound(c, "invoice");
  const lines = parseLines(s(f.get("lines")));
  if (!lines) return redirect(`/invoices/${id}`, "Each line needs a description and an amount, like: Drawing | 250.00", true);
  const addGst = f.get("add_gst") === "1";
  const t = invoiceTotals(lines, addGst);
  const status = INVOICE_STATUSES.some(([k]) => k === s(f.get("status"))) ? s(f.get("status")) : "draft";
  const date = (k: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s(f.get(k))) ? s(f.get(k)) : null);
  await c.env.DB.prepare(
    `UPDATE invoices SET status=?, issued_on=COALESCE(?, issued_on), due_on=COALESCE(?, due_on), lines_json=?, gst_registered=?, subtotal_cents=?, gst_cents=?, total_cents=?, notes=? WHERE id=?`,
  ).bind(status, date("issued_on"), date("due_on"), JSON.stringify(lines), addGst ? 1 : 0, t.subtotal_cents, t.gst_cents, t.total_cents, s(f.get("notes")).trim(), id).run();
  return redirect(`/invoices/${id}`, "Invoice saved.");
}

// ---------- Settings ----------

const SETTING_FIELDS = ["business_name", "abn", "email", "phone", "address", "payment_terms_days", "payment_details", "drawn_by", "default_disclaimer", "job_prefix", "invoice_prefix"];

async function settingsPage(c: Ctx): Promise<Response> {
  const [st, tiers] = await Promise.all([settings(c.env), tiersList(c.env)]);
  // Per size: total minutes per job (only jobs with recorded time), then average, shortest, longest.
  const perJob = (await c.env.DB.prepare(
    `SELECT j.tier_id, j.id, SUM(t.minutes) AS mins FROM jobs j JOIN time_entries t ON t.job_id = j.id
      WHERE j.deleted_at IS NULL AND t.deleted_at IS NULL AND t.minutes IS NOT NULL AND j.tier_id IS NOT NULL GROUP BY j.id`,
  ).all<{ tier_id: number; id: number; mins: number }>()).results;
  const calib = tiers.map((t) => {
    const m = perJob.filter((r) => r.tier_id === Number(t.id)).map((r) => r.mins);
    return { name: s(t.name), price: n(t.price_cents), jobs: m.length, avg: m.length ? m.reduce((a, b) => a + b, 0) / m.length : 0, min: Math.min(...m), max: Math.max(...m) };
  });
  const nextJob = formatNumber(st.job_prefix, Number(st.job_next), Number(st.job_pad));
  const nextInv = formatNumber(st.invoice_prefix, Number(st.invoice_next), Number(st.invoice_pad));
  const tierRows = tiers.map((t) => [`<b>${esc(t.name)}</b>`, esc(t.description), `<span class="num">${n(t.price_cents) ? formatDollars(n(t.price_cents)) : '<span class="muted">Not set</span>'}</span>`,
    iconBtn({ icon: "pencil", label: `Edit ${s(t.name)}`, dialog: `edit-tier-${t.id}` }) + iconBtn({ icon: "bin", label: `Delete ${s(t.name)}`, dialog: `del-tier-${t.id}`, danger: true })]);
  const tierDlgs = tiers.map((t) => formDialog(`edit-tier-${t.id}`, `Edit ${esc(t.name)}`, `/tiers/${t.id}`, tierFields(t)) + confirmDelete(`del-tier-${t.id}`, `the ${s(t.name)} size`, `/tiers/${t.id}/delete`)).join("");
  const body = `<div class="bar"><h1>Settings</h1>${c.user.role === "owner" ? iconBtn({ icon: "download", label: "Download all Sprigboard data (JSON backup)", href: "/settings/export.json", download: true }) : ""}</div>
    <div class="bar"><h2>Job sizes and prices</h2>${iconBtn({ icon: "plus", label: "Add a size", dialog: "new-tier" })}</div>
    <p class="sub">You price by the size of the job, not by the hour. Time a few practice jobs, then set a price for each size.</p>
    ${table(["Size", "What it covers", "Price (before GST)", "Actions"], tierRows, "No sizes yet.")}
    <h2>How long jobs take</h2>
    <p class="sub small">From the time you record on jobs (finished timers and hand-entered time). Use it to check each size's price; the last column is what the price works out to per hour.</p>
    ${table(["Size", "Jobs timed", "Average", "Shortest", "Longest", "Price per hour"], calib.map((k) => [
      `<b>${esc(k.name)}</b>`, String(k.jobs), k.jobs ? formatMinutes(k.avg) : "—", k.jobs ? formatMinutes(k.min) : "—", k.jobs ? formatMinutes(k.max) : "—",
      k.jobs && k.price ? `${formatDollars(Math.round(k.price / (k.avg / 60)))}/h` : '<span class="muted">—</span>',
    ]), "No sizes yet.")}
    <h2>Business and invoices</h2>
    <div class="panel bar" style="margin-bottom:12px">${st.business_logo_key ? `<img class="thumb" src="/settings/logo" alt="" style="width:auto;max-width:120px;height:40px">` : ""}
      <span class="grow"><b>Your logo</b><br><span class="small muted">${st.business_logo_key ? "Shown at the top of your invoices." : "Add your logo to show it at the top of your invoices."}</span></span>
      ${iconBtn({ icon: "upload", label: st.business_logo_key ? "Replace your logo" : "Upload your logo", dialog: "biz-logo" })}
      ${st.business_logo_key ? iconBtn({ icon: "bin", label: "Remove your logo", dialog: "del-biz-logo", danger: true }) : ""}</div>
    ${formDialog("biz-logo", "Your logo", "/settings/logo", `<label class="fld full"><span>Logo image</span><input type="file" name="logo" required accept="image/svg+xml,image/png,image/jpeg,image/webp"><small>PNG, SVG, JPEG or WebP, up to 1 MB.</small></label>`, "Upload", "multipart/form-data")}
    ${confirmDelete("del-biz-logo", "your logo", "/settings/logo/delete")}
    <form method="post" action="/settings" class="panel"><div class="grid">
      ${field("business_name", "Business name", st.business_name, { required: true })}${field("abn", "ABN", st.abn, { attrs: 'inputmode="numeric"' })}
      ${field("email", "Email", st.email, { type: "email" })}${field("phone", "Phone", st.phone)}
      ${area("address", "Business address", st.address, { rows: 2 })}
      <div class="full">${toggle("gst_registered", "Registered for GST", st.gst_registered === "1", "Your business is registered for GST. Invoices that add GST are then titled Tax invoice.")}</div>
      <div class="full">${toggle("gst_on_invoices", "Add GST to invoices", st.gst_on_invoices === "1", "Adds 10% GST on top of the price on new invoices, separately from the setting above. You can still switch GST on or off for each invoice. Existing invoices don't change.")}
        ${st.gst_on_invoices === "1" && st.gst_registered !== "1" ? `<p class="flash err small" style="margin-top:8px">GST is being added but the business isn't marked as registered for GST. In Australia only GST-registered businesses may charge GST.</p>` : ""}</div>
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
  return layout({ title: "Settings", path: c.url.pathname, user: c.user, body, flash: flashOf(c.url) });
}

const tierFields = (t: Row) => `${field("name", "Size name", s(t.name), { required: true })}
  ${field("price", "Price (AUD, before GST)", n(t.price_cents) ? (n(t.price_cents) / 100).toFixed(2) : "", { attrs: 'inputmode="decimal" placeholder="0.00"' })}
  ${area("description", "What it covers", s(t.description), { rows: 2 })}${field("sort", "Order", s(t.sort ?? 0), { type: "number" })}`;

async function saveSettings(c: Ctx): Promise<Response> {
  const f = await c.req.formData();
  const stmts = SETTING_FIELDS.map((k) => c.env.DB.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(k, s(f.get(k)).trim()));
  stmts.push(c.env.DB.prepare(`UPDATE settings SET value=? WHERE key='gst_registered'`).bind(f.get("gst_registered") === "1" ? "1" : "0"));
  stmts.push(c.env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('gst_on_invoices', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).bind(f.get("gst_on_invoices") === "1" ? "1" : "0"));
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

/** Explains the per-invoice GST switch, warning when GST would be charged without registration. */
function gstHint(st: Record<string, string>, registeredAtTheTime = st.gst_registered === "1"): string {
  return registeredAtTheTime
    ? "Your default is set in Settings → Add GST to invoices."
    : "Your business isn't marked as registered for GST. In Australia only GST-registered businesses may charge it.";
}

// ---------- Getting started ----------

async function gettingStarted(c: Ctx): Promise<string> {
  const st = await settings(c.env);
  if (st.onboarding_hidden === "1") return "";
  const one = async (sql: string) => n((await c.env.DB.prepare(sql).first<{ n: number }>())?.n);
  const signIn = await c.env.DB.prepare(`SELECT (password_hash IS NOT NULL) + (SELECT COUNT(*) FROM passkeys WHERE user_id=users.id) AS n FROM users WHERE id=?`).bind(c.user.id).first<{ n: number }>();
  const steps: [boolean, string, string][] = [
    [st.business_name !== "Your business name" && !!st.business_name, "Add your business details", "/settings"],
    [(await one(`SELECT COUNT(*) AS n FROM size_tiers WHERE deleted_at IS NULL AND price_cents > 0`)) > 0, "Set a price for each job size", "/settings"],
    [(await one(`SELECT COUNT(*) AS n FROM clients WHERE deleted_at IS NULL`)) > 0, "Add Shane's business as a client, with his copyright line", "/clients"],
    [(await one(`SELECT COUNT(*) AS n FROM plant_symbols WHERE deleted_at IS NULL`)) > 0, "Add your plant graphics (or import a CSV list)", "/plants"],
    [n(signIn?.n) > 0, "Add a passkey or password so you can sign in without an email code", "/account"],
    [(await one(`SELECT COUNT(*) AS n FROM jobs WHERE deleted_at IS NULL`)) > 0, "Create your first job", "/"],
  ];
  const left = steps.filter(([done]) => !done).length;
  if (!left) return "";
  return `<section class="panel onboard" aria-label="Getting started"><div class="bar"><b class="grow">Getting started · ${steps.length - left} of ${steps.length} done</b>
    <form method="post" action="/settings/onboarding/hide" class="inline">${iconBtn({ icon: "x", label: "Hide this checklist" })}</form></div>
    <ol>${steps.map(([done, text, href]) => `<li class="${done ? "done" : ""}">${done ? icon("check") : `<span class="todo-dot" aria-hidden="true"></span>`}${done ? `<span>${esc(text)}</span>` : `<a href="${href}">${esc(text)}</a>`}</li>`).join("")}</ol></section>`;
}

// ---------- Time ----------

const nowSql = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function timeRoute(c: Ctx, jobId: number, action: string): Promise<Response> {
  if (!(await getJob(c.env, jobId))) return notFound(c, "job");
  const running = await c.env.DB.prepare(`SELECT id, started_at FROM time_entries WHERE job_id=? AND user_id=? AND ended_at IS NULL AND deleted_at IS NULL`).bind(jobId, c.user.id).first<{ id: number; started_at: string }>();
  if (action === "timer/start") {
    if (running) return redirect(`/jobs/${jobId}`, "The timer is already running.");
    // One timer at a time: stop any running on other jobs first.
    const others = (await c.env.DB.prepare(`SELECT id, started_at FROM time_entries WHERE user_id=? AND ended_at IS NULL AND deleted_at IS NULL`).bind(c.user.id).all<{ id: number; started_at: string }>()).results;
    const now = nowSql();
    await c.env.DB.batch([
      ...others.map((o) => c.env.DB.prepare(`UPDATE time_entries SET ended_at=?, minutes=? WHERE id=?`).bind(now, minutesBetween(o.started_at, now), o.id)),
      c.env.DB.prepare(`INSERT INTO time_entries (job_id, user_id, started_at) VALUES (?,?,?)`).bind(jobId, c.user.id, now),
    ]);
    return redirect(`/jobs/${jobId}`, others.length ? "Timer started (your timer on another job was stopped)." : "Timer started.");
  }
  if (action === "timer/stop") {
    if (!running) return redirect(`/jobs/${jobId}`, "No timer is running.");
    const now = nowSql(), mins = minutesBetween(running.started_at, now);
    await c.env.DB.prepare(`UPDATE time_entries SET ended_at=?, minutes=? WHERE id=?`).bind(now, mins, running.id).run();
    return redirect(`/jobs/${jobId}`, `Timer stopped: ${formatMinutes(mins)}.`);
  }
  const f = await c.req.formData();
  const mins = parseDuration(s(f.get("duration")));
  if (mins === null) return redirect(`/jobs/${jobId}`, "Enter the time like 90, 1:30 or 1.5h (up to 24 hours).", true);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(s(f.get("date"))) ? s(f.get("date")) : todayBrisbane();
  const start = `${date} 00:00:00`;
  await c.env.DB.prepare(`INSERT INTO time_entries (job_id, user_id, started_at, ended_at, minutes, note) VALUES (?,?,?,?,?,?)`).bind(jobId, c.user.id, start, start, mins, s(f.get("note")).trim().slice(0, 200)).run();
  return redirect(`/jobs/${jobId}`, `Added ${formatMinutes(mins)}.`);
}

// ---------- Plant import and data export ----------

async function importPlants(c: Ctx): Promise<Response> {
  const file = (await c.req.formData()).get("file");
  if (!file || typeof file === "string" || file.size === 0) return redirect("/plants", "Choose a CSV file.", true);
  if (file.size > 1024 * 1024) return redirect("/plants", "That file is too big (1 MB at most).", true);
  const parsed = plantRowsFromCsv(await file.text());
  if ("error" in parsed) return redirect("/plants", parsed.error, true);
  const existing = new Map((await symbolsList(c.env)).map((x) => [normalisePlant(s(x.botanical)), Number(x.id)]));
  let added = 0, updated = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const r of parsed.rows) {
    const id = existing.get(normalisePlant(r.botanical));
    if (id) { stmts.push(c.env.DB.prepare(`UPDATE plant_symbols SET botanical=?, common=CASE WHEN ?='' THEN common ELSE ? END, code=CASE WHEN ?='' THEN code ELSE ? END WHERE id=?`).bind(r.botanical, r.common, r.common, r.code, r.code, id)); updated++; }
    else { stmts.push(c.env.DB.prepare(`INSERT INTO plant_symbols (botanical, common, code) VALUES (?,?,?)`).bind(r.botanical, r.common, r.code)); existing.set(normalisePlant(r.botanical), -1); added++; }
  }
  for (let i = 0; i < stmts.length; i += 50) await c.env.DB.batch(stmts.slice(i, i + 50));
  return redirect("/plants", `Imported ${added} new plant${added === 1 ? "" : "s"}${updated ? `, updated ${updated}` : ""}.${parsed.skipped ? ` Skipped ${parsed.skipped} row${parsed.skipped === 1 ? "" : "s"} without a botanical name.` : ""}`);
}

async function exportData(c: Ctx): Promise<Response> {
  const tables = ["settings", "clients", "size_tiers", "jobs", "plan_files", "checklist_items", "plant_symbols", "invoices"];
  const out: Record<string, unknown> = { exported_at: new Date().toISOString(), app: "Sprigboard" };
  for (const t of tables) out[t] = (await c.env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  // Accounts without any secrets (no password hashes, sessions, passkeys or tokens).
  out.users = (await c.env.DB.prepare(`SELECT id, email, name, role, created_at, last_login_at, deleted_at FROM users`).all()).results;
  return download(JSON.stringify(out, null, 2), `sprigboard-export-${todayBrisbane()}.json`, "application/json; charset=utf-8");
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
      return serveObject(env, cl?.logo_key ? s(cl.logo_key) : null, "logo");
    }
    if (p === "/plants") return plantsPage(c);
    if (p === "/plants.csv") {
      const syms = await symbolsList(env);
      return download(toCsv([["botanical", "common", "code", "symbol_file"], ...syms.map((x) => [s(x.botanical), s(x.common), s(x.code), s(x.filename)])]), "plant-library.csv", "text/csv; charset=utf-8");
    }
    if (p === "/settings/logo") return serveObject(env, (await settings(env)).business_logo_key || null, "logo");
    if (p === "/settings/export.json") return c.user.role === "owner" ? exportData(c) : notFound(c);
    if (p === "/clients") return clientsPage(c);
    if (p === "/invoices") return invoicesPage(c);
    if ((r = m(/^\/invoices\/(\d+)$/))) return invoicePage(c, +r[1]);
    if (p === "/settings") return settingsPage(c);
    if (p === "/account") return accountPage(c);
    if (p === "/users") return c.user.role === "owner" ? usersPage(c) : notFound(c);
    return notFound(c);
  }

  if (req.method === "POST") {
    if (p.startsWith("/account/")) return (await accountPost(c)) ?? notFound(c);
    if (p.startsWith("/passkeys/")) return (await passkeyAccountRoute(env, req, url, c.user)) ?? notFound(c);
    if (p === "/users" || p.startsWith("/users/")) return (await usersPost(c)) ?? notFound(c);
    if (p === "/jobs") return createJob(c);
    if ((r = m(/^\/jobs\/(\d+)$/))) return updateJob(c, +r[1]);
    if ((r = m(/^\/jobs\/(\d+)\/delete$/))) { await softDelete(env, "jobs", +r[1]); return redirect("/", "Job deleted."); }
    if ((r = m(/^\/jobs\/(\d+)\/files$/))) return uploadFiles(c, +r[1]);
    if ((r = m(/^\/jobs\/(\d+)\/(timer\/start|timer\/stop|time)$/))) return timeRoute(c, +r[1], r[2]);
    if ((r = m(/^\/time\/(\d+)\/delete$/))) {
      const t = await env.DB.prepare(`SELECT job_id FROM time_entries WHERE id=? AND deleted_at IS NULL`).bind(+r[1]).first<{ job_id: number }>();
      if (!t) return notFound(c, "time entry");
      await softDelete(env, "time_entries", +r[1]);
      return redirect(`/jobs/${t.job_id}`, "Time entry deleted.");
    }
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
    if (p === "/plants/import") return importPlants(c);
    if ((r = m(/^\/plants\/(\d+)\/delete$/))) { await softDelete(env, "plant_symbols", +r[1]); return redirect("/plants", "Plant deleted."); }
    if ((r = m(/^\/plants\/(\d+)$/))) return savePlant(c, +r[1]);
    if (p === "/clients") return saveClient(c, null);
    if ((r = m(/^\/clients\/(\d+)\/delete$/))) { await softDelete(env, "clients", +r[1]); return redirect("/clients", "Client deleted."); }
    if ((r = m(/^\/clients\/(\d+)$/))) return saveClient(c, +r[1]);
    if ((r = m(/^\/invoices\/(\d+)\/delete$/))) { await softDelete(env, "invoices", +r[1]); return redirect("/invoices", "Invoice deleted. Its number is not reused."); }
    if ((r = m(/^\/invoices\/(\d+)\/email$/))) return emailInvoice(c, +r[1]);
    if ((r = m(/^\/invoices\/(\d+)$/))) return updateInvoice(c, +r[1]);
    if (p === "/settings") return saveSettings(c);
    if (p === "/settings/logo") {
      const logo = (await req.formData()).get("logo");
      if (!logo || typeof logo === "string" || !isImage(logo.type) || logo.size > 1024 * 1024) return redirect("/settings", "Choose a PNG, SVG, JPEG or WebP image up to 1 MB.", true);
      const key = fileKey("business", logo.name);
      await putFile(env, key, logo, logo.type);
      await env.DB.prepare(`UPDATE settings SET value=? WHERE key='business_logo_key'`).bind(key).run();
      return redirect("/settings", "Logo saved.");
    }
    if (p === "/settings/logo/delete") {
      await env.DB.prepare(`UPDATE settings SET value='' WHERE key='business_logo_key'`).run();
      return redirect("/settings", "Logo removed.");
    }
    if (p === "/settings/onboarding/hide") {
      await env.DB.prepare(`INSERT INTO settings (key, value) VALUES ('onboarding_hidden','1') ON CONFLICT(key) DO UPDATE SET value='1'`).run();
      return redirect("/");
    }
    if (p === "/tiers") return saveTier(c, null);
    if ((r = m(/^\/tiers\/(\d+)\/delete$/))) { await softDelete(env, "size_tiers", +r[1]); return redirect("/settings", "Size deleted."); }
    if ((r = m(/^\/tiers\/(\d+)$/))) return saveTier(c, +r[1]);
    return notFound(c);
  }
  return new Response("Method not allowed", { status: 405 });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (req.method === "POST" && !sameOrigin(req, url)) return new Response("Cross-site request refused.", { status: 403 });
      const pub = (await authRoute({ env, req, url })) ?? (await passkeyLoginRoute(env, req, url));
      if (pub) return pub;
      const user = await currentUser(env, req);
      if (!user) {
        if (req.method !== "GET") return new Response("Please sign in again.", { status: 401 });
        const next = url.pathname === "/" ? "" : `?next=${encodeURIComponent(url.pathname + url.search)}`;
        return new Response(null, { status: 303, headers: { location: `/login${next}` } });
      }
      try {
        return await route({ env, req, url, user });
      } catch (e) {
        if (e instanceof StorageError) {
          // Back to the page the form was on (same site only).
          let back = "/";
          try { const r = new URL(req.headers.get("referer") ?? "", url); if (r.origin === url.origin) back = r.pathname; } catch { /* keep "/" */ }
          return redirect(back, e.message, true);
        }
        throw e;
      }
    } catch (e) {
      console.error(e);
      return new Response("Something went wrong. Please try again.", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  },
} satisfies ExportedHandler<Env>;
