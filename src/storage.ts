// File storage: R2 when the FILES bucket is bound, otherwise small files (up to 1 MB) in a D1 table.
// That lets Jamie add plant graphics, logos and small plans before R2 is enabled on Ben's account.
// Reads look in R2 first, then D1, so files saved either way keep working after R2 is switched on.

export interface StorageEnv {
  DB: D1Database;
  FILES?: R2Bucket;
}

export const D1_MAX_BYTES = 1024 * 1024;

export class StorageError extends Error {}

export function storageMode(env: StorageEnv): "r2" | "d1" {
  return env.FILES ? "r2" : "d1";
}

/** Largest file that can be stored right now. */
export function maxUpload(env: StorageEnv, r2Max: number): number {
  return env.FILES ? r2Max : D1_MAX_BYTES;
}

export function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}

export async function putFile(env: StorageEnv, key: string, file: File | Blob, mime: string): Promise<void> {
  if (env.FILES) {
    await env.FILES.put(key, file.stream(), { httpMetadata: { contentType: mime } });
    return;
  }
  if (file.size > D1_MAX_BYTES) {
    throw new StorageError(`Files over ${sizeLabel(D1_MAX_BYTES)} need R2 storage, which isn't turned on yet in the Cloudflare account.`);
  }
  await env.DB.prepare(`INSERT INTO blobs (key, mime, size, data) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET mime=excluded.mime, size=excluded.size, data=excluded.data`)
    .bind(key, mime, file.size, await file.arrayBuffer()).run();
}

export interface StoredFile { body: ReadableStream | ArrayBuffer; mime: string; size: number }

export async function getFile(env: StorageEnv, key: string): Promise<StoredFile | null> {
  if (env.FILES) {
    const obj = await env.FILES.get(key);
    if (obj) return { body: obj.body, mime: obj.httpMetadata?.contentType ?? "application/octet-stream", size: obj.size };
  }
  const row = await env.DB.prepare(`SELECT mime, size, data FROM blobs WHERE key=?`).bind(key).first<{ mime: string; size: number; data: ArrayBuffer | number[] }>();
  if (!row) return null;
  // D1 returns BLOB columns as an array of bytes.
  const data = row.data instanceof ArrayBuffer ? row.data : new Uint8Array(row.data).buffer;
  return { body: data, mime: row.mime, size: row.size };
}

/** The whole file as bytes (for plan reading). */
export async function getBytes(env: StorageEnv, key: string): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  const f = await getFile(env, key);
  if (!f) return null;
  return { bytes: f.body instanceof ArrayBuffer ? f.body : await new Response(f.body).arrayBuffer(), mime: f.mime };
}
