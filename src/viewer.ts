// File viewer: shows any file Sprigboard stores or creates inside a pop-up.
// Images, PDFs, PDF-compatible Illustrator files, CSV (as a table), XML/JSON/text, video and audio
// are shown in the browser; anything a browser can't draw (EPS, legacy AI, Office files) gets its
// details and a download button.

import { esc, parseCsv } from "./lib";

export type ViewKind = "image" | "pdf" | "ai-pdf" | "ai-legacy" | "eps" | "csv" | "text" | "video" | "audio" | "office" | "other";

const ext = (name: string) => (/\.([a-z0-9]{1,8})$/i.exec(name)?.[1] ?? "").toLowerCase();

/** "%PDF" at the start (or within the first 1 KB, which some writers allow). */
export function looksLikePdf(head: Uint8Array): boolean {
  const s = new TextDecoder("latin1").decode(head.subarray(0, 1024));
  return s.includes("%PDF-");
}

/** Works out how to show a file from its name, type and first bytes. */
export function detectKind(name: string, mime: string, head?: Uint8Array): ViewKind {
  const e = ext(name), m = (mime || "").toLowerCase();
  if (e === "ai" || m === "application/illustrator" || m === "application/vnd.adobe.illustrator") return head && looksLikePdf(head) ? "ai-pdf" : "ai-legacy";
  if (e === "eps" || e === "ps" || m === "application/postscript") return head && looksLikePdf(head) ? "ai-pdf" : "eps";
  if (m === "application/pdf" || e === "pdf") return "pdf";
  if (/^image\/(png|jpeg|gif|webp|svg\+xml|avif|bmp)$/.test(m) || ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"].includes(e)) return "image";
  if (m.startsWith("text/csv") || e === "csv") return "csv";
  if (m.startsWith("text/") || /(xml|json)/.test(m) || ["txt", "md", "xml", "json", "log"].includes(e)) return "text";
  if (/^video\/(mp4|webm|ogg)/.test(m) || ["mp4", "webm", "mov"].includes(e)) return "video";
  if (/^audio\//.test(m) || ["mp3", "wav", "m4a", "ogg"].includes(e)) return "audio";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods"].includes(e)) return "office";
  return "other";
}

/** The type to serve the raw bytes as, so the browser draws them (a PDF-compatible .ai becomes a PDF). */
export function inlineMime(kind: ViewKind, mime: string, name: string): string {
  if (kind === "pdf" || kind === "ai-pdf") return "application/pdf";
  if (kind === "image") {
    const e = ext(name);
    return mime.startsWith("image/") ? mime : e === "svg" ? "image/svg+xml" : e === "jpg" ? "image/jpeg" : `image/${e}`;
  }
  return mime || "application/octet-stream";
}

export const KIND_LABEL: Record<ViewKind, string> = {
  image: "Image", pdf: "PDF", "ai-pdf": "Adobe Illustrator (PDF-compatible)", "ai-legacy": "Adobe Illustrator", eps: "EPS / PostScript",
  csv: "CSV spreadsheet", text: "Text", video: "Video", audio: "Audio", office: "Office document", other: "File",
};

const NO_PREVIEW: Partial<Record<ViewKind, string>> = {
  "ai-legacy": "This Illustrator file was saved without PDF compatibility, so a browser can't draw it. Download it to open in Illustrator. Tip: in Illustrator, Save As with \"Create PDF Compatible File\" ticked and it will preview here.",
  eps: "Browsers can't draw EPS or PostScript files. Download it to open in Illustrator or another design app.",
  office: "Browsers can't show Office documents directly. Download it to open in Word, Excel or a similar app.",
  other: "There's no preview for this kind of file. Download it to open it.",
};

export function csvTable(text: string, maxRows = 500): string {
  const rows = parseCsv(text);
  if (!rows.length) return `<p class="muted">The file is empty.</p>`;
  const [head, ...body] = rows;
  const shown = body.slice(0, maxRows);
  return `<div class="tablewrap"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${shown.map((r) => `<tr>${head.map((_, i) => `<td>${esc(r[i] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
    ${body.length > maxRows ? `<p class="muted small">Showing the first ${maxRows} of ${body.length} rows. Download for the rest.</p>` : ""}`;
}

export function textBlock(text: string, maxChars = 200_000): string {
  let t = text;
  // Pretty-print JSON when it parses.
  try { if (/^\s*[[{]/.test(t)) t = JSON.stringify(JSON.parse(t), null, 2); } catch { /* leave as is */ }
  const cut = t.length > maxChars;
  return `<pre class="code">${esc(cut ? t.slice(0, maxChars) : t)}</pre>${cut ? `<p class="muted small">Showing the first ${Math.round(maxChars / 1000)} KB. Download for the rest.</p>` : ""}`;
}

export interface ViewInfo {
  name: string;
  kind: ViewKind;
  size?: number;
  rawUrl?: string;       // inline bytes (images, PDFs, media)
  downloadUrl: string;
  text?: string;         // already-read content for CSV/text
}

const sizeText = (b?: number) => (b === undefined ? "" : b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** The inner content of the viewer for one file. */
export function viewerContent(v: ViewInfo): string {
  switch (v.kind) {
    case "image":
      return `<div class="v-img" data-zoom="fit"><img src="${esc(v.rawUrl)}" alt="${esc(v.name)}"></div>`;
    case "pdf": case "ai-pdf":
      // Pages are drawn with PDF.js so they show on phones and tablets too (mobile browsers don't
      // show PDFs inside a frame). If PDF.js can't load, the browser's own viewer takes over.
      return `${v.kind === "ai-pdf" ? `<p class="muted small v-note">Showing the PDF copy saved inside this Illustrator file. Layers and editable artwork open in Illustrator.</p>` : ""}
        <div class="v-pages" id="v-pages" data-src="${esc(v.rawUrl)}" aria-label="${esc(v.name)}"><p class="muted small" id="v-status">Loading pages…</p></div>
        <script type="module">${PDF_JS}</script>`;
    case "csv": return csvTable(v.text ?? "");
    case "text": return textBlock(v.text ?? "");
    case "video": return `<video class="v-media" src="${esc(v.rawUrl)}" controls preload="metadata"></video>`;
    case "audio": return `<audio class="v-audio" src="${esc(v.rawUrl)}" controls preload="metadata"></audio>`;
    default:
      return `<div class="v-none"><p><b>${esc(KIND_LABEL[v.kind])}</b>${v.size !== undefined ? ` · ${sizeText(v.size)}` : ""}</p><p>${esc(NO_PREVIEW[v.kind] ?? NO_PREVIEW.other!)}</p>
        <a class="btn btn-primary" href="${esc(v.downloadUrl)}" download>Download ${esc(v.name)}</a></div>`;
  }
}

/** The viewer's toolbar: name, type, size and actions. */
export function viewerToolbar(v: ViewInfo, icon: (n: string) => string): string {
  const btn = (ic: string, label: string, attrs: string) => `<a class="ib" aria-label="${esc(label)}" data-tip="${esc(label)}" ${attrs}>${icon(ic)}</a>`;
  return `<div class="v-bar"><div class="v-name"><b>${esc(v.name)}</b><span class="muted small">${esc(KIND_LABEL[v.kind])}${v.size !== undefined ? ` · ${sizeText(v.size)}` : ""}</span></div>
    ${v.kind === "image" ? `<button type="button" class="ib" id="v-zoom" aria-label="Show actual size" data-tip="Show actual size">${icon("zoom")}</button>` : ""}
    ${v.rawUrl && v.kind !== "ai-legacy" && v.kind !== "eps" ? btn("external", "Open in a new tab", `href="${esc(v.rawUrl)}" target="_blank" rel="noopener"`) : ""}
    ${btn("download", `Download ${v.name}`, `href="${esc(v.downloadUrl)}" download`)}</div>`;
}

export const PDFJS_VERSION = "4.10.38";

const PDF_JS = `
const box = document.getElementById("v-pages"), status = document.getElementById("v-status");
const fallback = () => { box.innerHTML = '<iframe class="v-pdf" title="PDF" src="' + box.dataset.src + '#view=FitH"></iframe>'; };
try {
  const lib = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs");
  lib.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs";
  const pdf = await lib.getDocument({ url: box.dataset.src, isEvalSupported: false }).promise;
  const max = Math.min(pdf.numPages, 50);
  status.textContent = pdf.numPages + (pdf.numPages === 1 ? " page" : " pages") + (pdf.numPages > max ? " (showing the first " + max + ")" : "");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (let i = 1; i <= max; i++) {
    const page = await pdf.getPage(i);
    const width = box.clientWidth || 800, base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width / base.width) * dpr });
    const c = document.createElement("canvas");
    c.width = vp.width; c.height = vp.height; c.style.width = "100%"; c.className = "v-page";
    c.setAttribute("aria-label", "Page " + i);
    box.appendChild(c);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  }
  document.documentElement.dataset.pdfPages = String(max);
} catch (e) { console.warn("PDF.js could not show this file", e); fallback(); }
`;
