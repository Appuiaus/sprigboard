// Reads a landscape plan (PDF or image) with Claude and returns a draft
// checklist: plants, street names, dimensions and other markings. The draft is
// only a suggestion: Jamie ticks each item off against the plan herself.

import Anthropic from "@anthropic-ai/sdk";

export const EXTRACT_MODEL = "claude-opus-5-5";

export const ITEM_KINDS = ["plant", "street", "dimension", "marking", "note"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export interface ExtractedItem {
  kind: ItemKind;
  label: string;    // what is written on the plan, e.g. "Lomandra longifolia 'Tanika'"
  detail: string;   // context, e.g. "front garden bed, pot size 140mm"
  quantity: string; // as written, e.g. "12", "" when not given
}

export interface Extraction {
  items: ExtractedItem[];
  scale: string;          // the drawing scale if printed on the plan, e.g. "1:200 @ A3"
  site_address: string;   // the job address if printed on the plan
  summary: string;        // one or two sentences on what the plan shows
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items", "scale", "site_address", "summary"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "label", "detail", "quantity"],
        properties: {
          kind: { type: "string", enum: [...ITEM_KINDS] },
          label: { type: "string" },
          detail: { type: "string" },
          quantity: { type: "string" },
        },
      },
    },
    scale: { type: "string" },
    site_address: { type: "string" },
    summary: { type: "string" },
  },
} as const;

const SYSTEM = `You help a graphic designer redraw landscape design plans as presentation drawings.
You receive one plan (a PDF or an image). List everything she would otherwise retype by hand:

- plant: every plant named in a plant schedule, legend or label. Use the botanical name as written (keep cultivar names in quotes). Put the common name, pot size, code or location in "detail" and the count in "quantity" when given. List each distinct plant once.
- street: street and road names, and other place names printed on the plan.
- dimension: dimensions and levels that describe the design (lengths, widths, areas, setbacks, heights, RLs). Put what each one measures in "detail".
- marking: other labelled features: fences, walls, paving, decks, edging, playground equipment, water features, existing trees to keep or remove, north point.
- note: notes printed on the plan that may matter for the drawing.

Copy text exactly as printed. Do not guess text you cannot read: list it as a note saying it is illegible and where it is. Use "" for any field the plan doesn't give.`;

export type PlanSource = { mime: string; bytes: ArrayBuffer };

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

export function isSupportedPlan(mime: string): boolean {
  return mime === "application/pdf" || (IMAGE_TYPES as readonly string[]).includes(mime);
}

/**
 * The plan goes to Claude through the Files API: the Worker streams the bytes up once and refers to
 * the file by id. That avoids base64-encoding a large PDF inside the Worker, which would blow the
 * Workers Free CPU limit (10 ms per request). The uploaded copy is deleted straight after reading.
 */
export function planBlock(mime: string, fileId: string): Anthropic.Beta.BetaContentBlockParam {
  if (mime === "application/pdf") return { type: "document", source: { type: "file", file_id: fileId } };
  if (!(IMAGE_TYPES as readonly string[]).includes(mime)) throw new Error(`Unsupported file type ${mime}`);
  return { type: "image", source: { type: "file", file_id: fileId } };
}

/** Validates the model's JSON and drops anything malformed rather than trusting it. */
export function parseExtraction(text: string): Extraction {
  const raw = JSON.parse(text) as Partial<Extraction>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map((i) => ({
      kind: (ITEM_KINDS as readonly string[]).includes(String(i?.kind)) ? (i.kind as ItemKind) : "note",
      label: str(i?.label),
      detail: str(i?.detail),
      quantity: str(i?.quantity),
    }))
    .filter((i) => i.label);
  return { items, scale: str(raw.scale), site_address: str(raw.site_address), summary: str(raw.summary) };
}

export class ExtractionError extends Error {}

export async function extractPlan(apiKey: string, src: PlanSource, filename: string, fetchImpl?: typeof fetch, instructions = ""): Promise<Extraction> {
  // fetchImpl is for tests only.
  const client = new Anthropic({ apiKey, maxRetries: 2, ...(fetchImpl ? { fetch: fetchImpl, baseURL: "https://api.test" } : {}) });
  if (!isSupportedPlan(src.mime)) throw new ExtractionError("Claude can read PDF, JPEG, PNG, GIF and WebP files.");
  let message: Anthropic.Beta.BetaMessage;
  let fileId: string | null = null;
  try {
    const uploaded = await client.files.upload({ file: new File([src.bytes], filename || "plan", { type: src.mime }) });
    fileId = uploaded.id;
    message = await client.beta.messages
      .stream({
        model: EXTRACT_MODEL,
        max_tokens: 32000,
        // On a safety decline the API retries the same request on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
        system: SYSTEM,
        messages: [{
          role: "user",
          content: [planBlock(src.mime, fileId), { type: "text", text: `Plan file: ${filename}. List its contents as described.${instructions.trim() ? `\n\nThe designer's own instructions for reading her plans (from her Settings):\n${instructions.trim()}` : ""}` }],
        }],
      })
      .finalMessage();
  } catch (e) {
    if (e instanceof ExtractionError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new ExtractionError("The Claude API key is missing or wrong.");
    if (e instanceof Anthropic.RateLimitError) throw new ExtractionError("Claude is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.BadRequestError) throw new ExtractionError(`Claude couldn't read this file: ${e.message}`);
    if (e instanceof Anthropic.APIError) throw new ExtractionError(`Claude API error ${e.status ?? ""}`.trim());
    throw e;
  } finally {
    if (fileId) await client.files.delete(fileId).catch((e) => console.error("could not delete uploaded plan", e));
  }
  if (message.stop_reason === "refusal") throw new ExtractionError("Claude declined to read this file.");
  if (message.stop_reason === "max_tokens") throw new ExtractionError("The plan has more detail than one read can hold. Try a single page.");
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  try {
    return parseExtraction(text);
  } catch {
    throw new ExtractionError("Claude's answer couldn't be read. Try again.");
  }
}
