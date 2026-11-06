// Shared page shell and UI pieces, following Pedro's UI conventions:
// table lists with an Actions column, small icon buttons with tooltips,
// pop-up dialogs (gradient, accent edge, blurred backdrop), pill toggles,
// and a System → Light → Dark colour mode switch.

import { esc } from "./lib";

const ICONS: Record<string, string> = {
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
  bin: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"/>',
  receipt: '<path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2-3 2zM8 8h8M8 12h8M8 16h5"/>',
  printer: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z"/><path d="M2 21c0-3 1.9-5.4 5.1-6"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
};

export const icon = (name: string) =>
  `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ""}</svg>`;

/** Small icon button. A link when href is given, a dialog opener when dialog is given, else a submit button. */
export function iconBtn(o: { icon: string; label: string; href?: string; dialog?: string; danger?: boolean; download?: boolean; attrs?: string }): string {
  const cls = `ib${o.danger ? " danger" : ""}`;
  const common = `class="${cls}" aria-label="${esc(o.label)}" data-tip="${esc(o.label)}" ${o.attrs ?? ""}`;
  if (o.href) return `<a ${common} href="${esc(o.href)}"${o.download ? " download" : ""}>${icon(o.icon)}</a>`;
  if (o.dialog) return `<button type="button" ${common} data-open="${esc(o.dialog)}">${icon(o.icon)}</button>`;
  return `<button type="submit" ${common}>${icon(o.icon)}</button>`;
}

export function table(headers: string[], rows: string[][], empty: string): string {
  if (!rows.length) return `<p class="empty">${empty}</p>`;
  const head = headers.map((h, i) => `<th${i === headers.length - 1 ? ' class="actions"' : ""}>${h}</th>`).join("");
  const body = rows.map((r) => `<tr>${r.map((c, i) => `<td${i === r.length - 1 ? ' class="actions"' : ""} data-label="${esc(headers[i].replace(/<[^>]+>/g, ""))}"><div class="cv">${c}</div></td>`).join("")}</tr>`).join("");
  return `<div class="tablewrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function dialog(id: string, title: string, body: string, opts: { danger?: boolean; wide?: boolean } = {}): string {
  return `<dialog id="${esc(id)}" class="dlg${opts.danger ? " dlg-danger" : ""}${opts.wide ? " wide" : ""}" aria-labelledby="${esc(id)}-t">
  <div class="dlg-head"><h2 id="${esc(id)}-t">${title}</h2><button type="button" class="ib" data-close aria-label="Close" data-tip="Close">${icon("x")}</button></div>
  ${body}</dialog>`;
}

/** A confirm-delete dialog that POSTs to action. */
export function confirmDelete(id: string, what: string, action: string): string {
  return dialog(id, `Delete ${esc(what)}?`, `<form method="post" action="${esc(action)}">
    <p>This removes ${esc(what)} from Sprigboard.</p>
    <div class="btns"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-danger">Delete</button></div></form>`, { danger: true });
}

export const field = (name: string, label: string, value = "", o: { type?: string; required?: boolean; full?: boolean; hint?: string; attrs?: string } = {}) =>
  `<label class="fld${o.full ? " full" : ""}"><span>${label}</span><input name="${name}" type="${o.type ?? "text"}" value="${esc(value)}"${o.required ? " required" : ""} ${o.attrs ?? ""}>${o.hint ? `<small>${o.hint}</small>` : ""}</label>`;

export const area = (name: string, label: string, value = "", o: { hint?: string; rows?: number } = {}) =>
  `<label class="fld full"><span>${label}</span><textarea name="${name}" rows="${o.rows ?? 3}">${esc(value)}</textarea>${o.hint ? `<small>${o.hint}</small>` : ""}</label>`;

export const select = (name: string, label: string, options: [string, string][], value: string, o: { full?: boolean } = {}) =>
  `<label class="fld${o.full ? " full" : ""}"><span>${label}</span><select name="${name}">${options.map(([v, t]) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;

export const toggle = (name: string, label: string, on: boolean, hint = "") =>
  `<label class="tgl"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""}><span class="track" aria-hidden="true"></span><span>${label}${hint ? `<small>${hint}</small>` : ""}</span></label>`;

export const pills = (name: string, label: string, options: [string, string][], value: string) =>
  `<fieldset class="pills full"><legend>${label}</legend>${options.map(([v, t]) => `<label><input type="radio" name="${name}" value="${esc(v)}"${v === value ? " checked" : ""}><span>${esc(t)}</span></label>`).join("")}</fieldset>`;

export const formDialog = (id: string, title: string, action: string, fields: string, submit = "Save", enctype = "") =>
  dialog(id, title, `<form method="post" action="${esc(action)}"${enctype ? ` enctype="${enctype}"` : ""}><div class="grid">${fields}</div>
    <div class="btns"><button type="button" class="btn" data-close>Cancel</button><button class="btn btn-primary">${esc(submit)}</button></div></form>`);

export const badge = (text: string, tone = "") => `<span class="badge ${tone}">${esc(text)}</span>`;

const NAV: [string, string, string][] = [
  ["/", "Jobs", "layers"],
  ["/plants", "Plant library", "leaf"],
  ["/clients", "Clients", "file"],
  ["/invoices", "Invoices", "receipt"],
  ["/settings", "Settings", "pencil"],
];

const CSS = `
:root{--bg:#f6f7f3;--fg:#1d231c;--muted:#5f6b5c;--line:#dfe4d9;--card:#fff;--accent:#3f7d4e;--accent-fg:#fff;--accent-soft:#e3efe2;
--danger:#b42318;--danger-soft:#fde7e4;--warn:#9a6700;--warn-soft:#fff3cd;--ok:#2f6f3e;--ok-soft:#e1f2e3;--focus:#7fb58a;
--dlg-a:#ffffff;--dlg-b:#f1f6ee;--shadow:0 20px 50px rgba(20,40,20,.25)}
:root[data-theme=dark]{--bg:#141813;--fg:#e8ede5;--muted:#9aa696;--line:#2c342a;--card:#1b2019;--accent:#7cc48c;--accent-fg:#0f1a10;--accent-soft:#223424;
--danger:#ff8a7a;--danger-soft:#3a1d19;--warn:#f2c35b;--warn-soft:#3a3016;--ok:#7cc48c;--ok-soft:#1f3322;--focus:#7cc48c;--dlg-a:#20271e;--dlg-b:#171c16;--shadow:0 20px 60px rgba(0,0,0,.6)}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141813;--fg:#e8ede5;--muted:#9aa696;--line:#2c342a;--card:#1b2019;--accent:#7cc48c;--accent-fg:#0f1a10;--accent-soft:#223424;
--danger:#ff8a7a;--danger-soft:#3a1d19;--warn:#f2c35b;--warn-soft:#3a3016;--ok:#7cc48c;--ok-soft:#1f3322;--focus:#7cc48c;--dlg-a:#20271e;--dlg-b:#171c16;--shadow:0 20px 60px rgba(0,0,0,.6)}}
*{box-sizing:border-box}html{color-scheme:light dark}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}main{max-width:1100px;margin:0 auto;padding:16px}
.ic{width:18px;height:18px;flex:none}
header.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top .in{max-width:1100px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:12px}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:18px;text-decoration:none;color:var(--accent)}
.brand .ic{width:22px;height:22px}
nav.main{display:flex;gap:2px;margin-left:8px;flex-wrap:wrap}
nav.main a{display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:8px;text-decoration:none;color:var(--muted)}
nav.main a:hover{background:var(--accent-soft);color:var(--fg)}nav.main a[aria-current]{background:var(--accent-soft);color:var(--fg);font-weight:600}
.top .who{margin-left:auto;color:var(--muted);font-size:13px}
#burger{display:none}
h1{font-size:24px;margin:8px 0 4px}h2{font-size:18px;margin:24px 0 8px}.sub{color:var(--muted);margin:0 0 16px}
.bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.bar h1,.bar h2{margin-right:auto}
.tablewrap{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
table{width:100%;border-collapse:collapse}th,td{padding:9px 12px;text-align:left;vertical-align:middle;border-bottom:1px solid var(--line)}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:color-mix(in srgb,var(--accent-soft) 45%,var(--card))}
tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:color-mix(in srgb,var(--accent-soft) 35%,transparent)}
td.actions,th.actions{text-align:right;white-space:nowrap;width:1%}td.num{text-align:right;font-variant-numeric:tabular-nums}
td.actions form{display:inline}
.empty{background:var(--card);border:1px dashed var(--line);border-radius:12px;padding:20px;color:var(--muted);text-align:center}
.ib{position:relative;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;padding:0;text-decoration:none;vertical-align:middle;margin-left:2px}
.ib:hover{border-color:var(--accent);color:var(--accent)}.ib.danger{color:var(--danger)}.ib.danger:hover{border-color:var(--danger);background:var(--danger-soft)}
.ib.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.ib.primary:hover{filter:brightness(1.08);color:var(--accent-fg)}
.ib:focus-visible,.btn:focus-visible,a:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.tip{position:fixed;z-index:100;pointer-events:none;background:var(--fg);color:var(--bg);font-size:12px;padding:4px 8px;border-radius:6px;white-space:nowrap;opacity:0;transition:opacity .12s}
.tip.on{opacity:1}
.btn{display:inline-flex;align-items:center;gap:6px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:7px 14px;font:inherit;cursor:pointer;text-decoration:none}
.btn-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}.btn-danger{background:var(--danger);border-color:var(--danger);color:#fff;font-weight:600}
.badge{display:inline-block;font-size:12px;padding:2px 8px;border-radius:999px;background:var(--accent-soft);color:var(--fg);white-space:nowrap}
.badge.warn{background:var(--warn-soft);color:var(--warn)}.badge.ok{background:var(--ok-soft);color:var(--ok)}.badge.bad{background:var(--danger-soft);color:var(--danger)}.badge.muted{background:transparent;border:1px solid var(--line);color:var(--muted)}
.muted{color:var(--muted)}.small{font-size:13px}
.flash{padding:10px 14px;border-radius:10px;margin:8px 0 16px;background:var(--ok-soft);color:var(--ok);border:1px solid color-mix(in srgb,var(--ok) 30%,transparent)}
.flash.err{background:var(--danger-soft);color:var(--danger);border-color:color-mix(in srgb,var(--danger) 30%,transparent)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.panel dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}.panel dt{color:var(--muted)}.panel dd{margin:0}
dialog.dlg{border:0;border-left:4px solid var(--accent);border-radius:14px;padding:0;width:min(560px,calc(100vw - 32px));max-height:calc(100vh - 32px);
background:linear-gradient(160deg,var(--dlg-a),var(--dlg-b));color:var(--fg);box-shadow:var(--shadow)}
dialog.dlg.wide{width:min(820px,calc(100vw - 32px))}dialog.dlg-danger{border-left-color:var(--danger)}
dialog.dlg::backdrop{background:rgba(10,20,10,.45);backdrop-filter:blur(4px)}
.dlg-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 0}.dlg-head h2{margin:0;font-size:18px}
dialog.dlg form,dialog.dlg>.body{padding:12px 16px 16px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.grid .full{grid-column:1/-1}
.fld{display:flex;flex-direction:column;gap:4px}.fld span{font-size:13px;font-weight:600}.fld small,.tgl small{color:var(--muted);font-size:12px;font-weight:400;display:block}
input,select,textarea{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;width:100%}
input[type=file]{padding:6px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--focus) 35%,transparent)}
.btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
.tgl{display:flex;align-items:flex-start;gap:10px;cursor:pointer}.tgl input{position:absolute;opacity:0;width:1px;height:1px}
.tgl .track{flex:none;width:40px;height:22px;border-radius:999px;background:var(--line);position:relative;transition:background .15s;margin-top:1px}
.tgl .track::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .15s}
.tgl input:checked+.track{background:var(--accent)}.tgl input:checked+.track::after{transform:translateX(18px)}
.tgl input:focus-visible+.track{outline:3px solid var(--focus);outline-offset:2px}
.tgl.mini{display:inline-flex;vertical-align:middle}
.pills{border:0;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:6px}.pills legend{font-size:13px;font-weight:600;margin-bottom:4px;padding:0}
.pills label{cursor:pointer}.pills input{position:absolute;opacity:0;width:1px;height:1px}
.pills span{display:inline-block;padding:6px 14px;border-radius:999px;border:1px solid var(--line);background:var(--card)}
.pills input:checked+span{background:var(--accent);border-color:var(--accent);color:var(--accent-fg);font-weight:600}
.pills input:focus-visible+span{outline:3px solid var(--focus);outline-offset:2px}
.thumb{width:36px;height:36px;object-fit:contain;border-radius:6px;background:#fff;border:1px solid var(--line);vertical-align:middle}
tr.done td:not(.actions){color:var(--muted)}tr.done .lbl{text-decoration:line-through}
.mode-btn{margin-left:4px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:720px){
 .top .who{display:none}#burger{display:inline-flex;margin-left:auto}
 nav.main{display:none;position:absolute;left:0;right:0;top:100%;flex-direction:column;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 16px;margin:0}
 nav.main.open{display:flex}
 .grid{grid-template-columns:1fr}
 table,thead,tbody,tr,td{display:block}thead{display:none}
 tr{border-bottom:1px solid var(--line);padding:6px 0}tbody tr:last-child{border-bottom:0}
 td{border:0;padding:3px 12px;display:flex;gap:12px;justify-content:space-between;text-align:right}
 td::before{content:attr(data-label);color:var(--muted);font-size:12px;text-transform:uppercase;text-align:left}
 td .cv{min-width:0;overflow-wrap:anywhere}td.actions{width:auto;justify-content:flex-end}td.actions::before{content:none}
}
@media print{header.top,.noprint{display:none!important}body{background:#fff;color:#000}main{padding:0}}
`;

// Runs in <head> before paint: applies the saved colour mode with no flash.
const HEAD_JS = `(function(){try{var m=localStorage.getItem("sb-mode");if(m==="light"||m==="dark")document.documentElement.dataset.theme=m}catch(e){}})();`;

const BODY_JS = `
(function(){
 var root=document.documentElement,btn=document.getElementById("mode");
 var order=["system","light","dark"],names={system:"System",light:"Light",dark:"Dark"};
 function cur(){return root.dataset.theme||"system"}
 function paint(){var m=cur();btn.querySelectorAll("[data-m]").forEach(function(s){s.hidden=s.dataset.m!==m});
  var l="Colour mode: "+names[m]+" (click to change)";btn.setAttribute("aria-label",l);btn.dataset.tip=l}
 btn.addEventListener("click",function(){var n=order[(order.indexOf(cur())+1)%3];
  if(n==="system"){delete root.dataset.theme;try{localStorage.removeItem("sb-mode")}catch(e){}}
  else{root.dataset.theme=n;try{localStorage.setItem("sb-mode",n)}catch(e){}}paint()});
 paint();
 var bg=document.getElementById("burger"),nav=document.getElementById("nav");
 bg.addEventListener("click",function(){var o=nav.classList.toggle("open");bg.setAttribute("aria-expanded",o);bg.setAttribute("aria-label",o?"Close menu":"Open menu")});
 document.addEventListener("click",function(e){var t=e.target.closest("[data-open]");if(t){var d=document.getElementById(t.dataset.open);if(d){d.showModal();var f=d.querySelector("input:not([type=hidden]),select,textarea");if(f)f.focus()}}
  var c=e.target.closest("[data-close]");if(c){c.closest("dialog").close()}
  if(e.target.tagName==="DIALOG"){var r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close()}});
 var tip=document.createElement("div");tip.className="tip";tip.setAttribute("role","tooltip");document.body.appendChild(tip);
 function show(el){tip.textContent=el.dataset.tip;var r=el.getBoundingClientRect();tip.classList.add("on");
  var w=tip.offsetWidth;tip.style.left=Math.max(4,Math.min(window.innerWidth-w-4,r.left+r.width/2-w/2))+"px";tip.style.top=(r.top-tip.offsetHeight-6<0?r.bottom+6:r.top-tip.offsetHeight-6)+"px"}
 function hide(){tip.classList.remove("on")}
 document.addEventListener("mouseover",function(e){var t=e.target.closest("[data-tip]");if(t)show(t);else hide()});
 document.addEventListener("focusin",function(e){var t=e.target.closest("[data-tip]");if(t)show(t);else hide()});
 document.addEventListener("focusout",hide);window.addEventListener("scroll",hide,true);
 document.querySelectorAll("form[data-autosubmit] input[type=checkbox]").forEach(function(c){c.addEventListener("change",function(){c.form.submit()})});
 document.querySelectorAll("form[data-busy]").forEach(function(f){f.addEventListener("submit",function(){var b=f.querySelector("button:not([data-close])");if(b){b.disabled=true;b.setAttribute("aria-busy","true")}var m=document.getElementById(f.dataset.busy);if(m)m.hidden=false})});
})();`;

export function layout(o: { title: string; path: string; email: string; body: string; flash?: { msg: string; err?: boolean } | null }): Response {
  const nav = NAV.map(([href, label, ic]) => {
    const active = href === "/" ? o.path === "/" || o.path.startsWith("/jobs") : o.path.startsWith(href);
    return `<a href="${href}"${active ? ' aria-current="page"' : ""}>${icon(ic)}${label}</a>`;
  }).join("");
  const flash = o.flash ? `<div class="flash${o.flash.err ? " err" : ""}" role="status">${esc(o.flash.msg)}</div>` : "";
  const html = `<!doctype html><html lang="en-AU"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(o.title)} · Sprigboard</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3f7d4e" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS.leaf}</svg>`)}">
<script>${HEAD_JS}</script><style>${CSS}</style></head><body>
<header class="top"><div class="in"><a class="brand" href="/">${icon("leaf")}Sprigboard</a>
<nav class="main" id="nav" aria-label="Main">${nav}</nav>
<span class="who">${esc(o.email)}</span>
<button type="button" class="ib" id="burger" aria-controls="nav" aria-expanded="false" aria-label="Open menu">${icon("menu")}</button>
<button type="button" class="ib mode-btn" id="mode"><span data-m="system">${icon("monitor")}</span><span data-m="light" hidden>${icon("sun")}</span><span data-m="dark" hidden>${icon("moon")}</span></button>
</div></header>
<main>${flash}${o.body}</main><script>${BODY_JS}</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "cache-control": "no-store" } });
}
