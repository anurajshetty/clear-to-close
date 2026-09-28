// Clear to Close — realtor media upload to Supabase Storage (Sept 2026,
// Anuraj-approved): the profile photo and banner upload to the public
// `realtor-media` bucket so client devices can see them. Previously photos
// stayed device-local.
//
// Path convention (Sept 28, 2026 revision — synchronous server-first
// writes): uploads go to UNIQUE per-upload paths
//   <userId>/photo-<uniqueId>.jpg
//   <userId>/banner-<uniqueId>.jpg
// and the profile row stores that path's public URL. The old single-
// overwrite convention (<userId>/photo.jpg) uploaded new bytes over the
// live file BEFORE the profile row confirmed, so a row failure left the
// publicly visible image changed with no local record of it. Unique paths
// never touch a live file: a row failure orphans an unreferenced file and
// every client keeps seeing the previously confirmed image. Uniqueness
// also replaces the old ?v= cache-buster: every upload is a distinct URL,
// so client surfaces drop the stale cached image immediately.
//
// Migration 0014's RLS policy only requires the first path segment to be
// auth.uid(), so unique paths under <uid>/ are permitted — no migration
// change needed. Files at the old fixed paths keep working (their stored
// URLs still resolve); the first save after this change moves the row to
// a unique path and the orphaned fixed-path file is deleted best-effort.
//
// Everything here is best-effort: any failure returns null and the profile
// stays local-only, exactly the old behavior. The local managed files
// (photoFile.ts) remain the offline source and the display fallback.
//
// NOTE: this module deliberately does NOT statically import react-native or
// expo-file-system — neither loads in plain node, and the unit tests import
// this module. Callers pass Platform.OS in; the native file reader is
// injectable for tests and dynamically imported in the app.
import type { Cloud } from './cloudSync';

export const REALTOR_MEDIA_BUCKET = 'realtor-media';

export type MediaKind = 'photo' | 'banner';

/**
 * Legacy fixed path for a kind (<userId>/photo.jpg). Kept as the delete
 * fallback for files uploaded before the unique-path change and by tests.
 */
export function storagePathFor(userId: string, kind: MediaKind): string {
  return `${userId}/${kind === 'photo' ? 'photo.jpg' : 'banner.jpg'}`;
}

/** Random per-upload id (no node/RN-only deps, so this loads in tests). */
function uniqueUploadId(): string {
  const time = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffffff)
    .toString(36)
    .padStart(7, '0');
  return `${time}${rand}`;
}

/**
 * Unique per-upload path: <userId>/<kind>-<uniqueId>.jpg. Never overwrites
 * a live file — a failed write orphans an unreferenced object instead of
 * changing what clients see.
 */
export function stagedUploadPath(userId: string, kind: MediaKind): string {
  return `${userId}/${kind}-${uniqueUploadId()}.jpg`;
}

/** Public URL for an uploaded file (no network call). */
export function publicUrlFor(client: Cloud, userId: string, kind: MediaKind): string | null {
  try {
    const { data } = client.storage.from(REALTOR_MEDIA_BUCKET).getPublicUrl(storagePathFor(userId, kind));
    return typeof data?.publicUrl === 'string' && data.publicUrl.length > 0 ? data.publicUrl : null;
  } catch {
    return null;
  }
}

/** Public URL for an arbitrary object path in the bucket (no network call). */
export function publicUrlForPath(client: Cloud, path: string): string | null {
  try {
    const { data } = client.storage.from(REALTOR_MEDIA_BUCKET).getPublicUrl(path);
    return typeof data?.publicUrl === 'string' && data.publicUrl.length > 0 ? data.publicUrl : null;
  } catch {
    return null;
  }
}

/**
 * Extract the bucket object path from a stored public URL
 * (…/realtor-media/<path>[?query]). Returns null when the URL does not
 * reference this bucket — callers fall back to the legacy fixed path.
 */
export function storagePathFromUrl(url: string | null): string | null {
  if (!url) return null;
  const marker = `/${REALTOR_MEDIA_BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx < 0) return null;
  const rest = url.slice(idx + marker.length).split('?')[0].split('#')[0];
  return rest.length > 0 ? rest : null;
}

/**
 * Cache-busted public URL (Sept 2026 — client stale-photo fix): the Storage
 * files are single-overwrite paths (`<uid>/photo.jpg`, `<uid>/banner.jpg`),
 * so re-uploads produce an identical URL and client devices keep showing the
 * old image from cache. Appending `?v=<upload timestamp>` makes every upload
 * a distinct URL, so the client surfaces show the new photo/banner right
 * after the realtor saves. Device-local fallbacks never carry the param.
 * `now` is injectable for tests.
 */
export function versionedPublicUrl(
  client: Cloud,
  userId: string,
  kind: MediaKind,
  now: () => number = Date.now,
): string | null {
  const base = publicUrlFor(client, userId, kind);
  if (!base) return null;
  return `${base}?v=${now()}`;
}

// ---------------------------------------------------------------------------
// base64 -> bytes (no Buffer/atob on React Native; tiny self-contained
// decoder so this works on native, web, and plain node for tests).

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const len = clean.length;
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array(((len * 3) / 4 - pad) | 0);
  let o = 0;
  for (let i = 0; i < len; i += 4) {
    const a = B64_CHARS.indexOf(clean[i]);
    const b = B64_CHARS.indexOf(clean[i + 1]);
    const c = B64_CHARS.indexOf(clean[i + 2]);
    const d = B64_CHARS.indexOf(clean[i + 3]);
    const triple = ((a & 63) << 18) | ((b & 63) << 12) | ((c & 63) << 6) | (d & 63);
    if (o < out.length) out[o++] = (triple >> 16) & 255;
    if (o < out.length) out[o++] = (triple >> 8) & 255;
    if (o < out.length) out[o++] = triple & 255;
  }
  return out;
}

/**
 * Read the bytes of a managed image URI. `data:` URIs (the web managed
 * files) resolve via fetch; anything else goes through the native file
 * reader (expo-file-system, dynamically imported so plain node never loads
 * it). `readNativeBase64` lets tests inject the native read. Returns null
 * when unreadable.
 */
export async function readImageBytes(
  uri: string,
  readNativeBase64?: (uri: string) => Promise<string | null>,
): Promise<Uint8Array | null> {
  try {
    if (uri.startsWith('data:')) {
      // Web managed file (or any data: URI): fetch resolves data: URIs.
      const res = await fetch(uri);
      if (!res.ok) return null;
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    }
    const reader = readNativeBase64 ?? defaultNativeRead;
    const b64 = await reader(uri);
    if (!b64) return null;
    return base64ToBytes(b64);
  } catch {
    return null;
  }
}

async function defaultNativeRead(uri: string): Promise<string | null> {
  try {
    const fs = await import('expo-file-system/legacy');
    return await fs.readAsStringAsync(uri, { encoding: fs.EncodingType.Base64 });
  } catch {
    return null;
  }
}

/**
 * Upload the realtor's managed photo/banner to Storage and return its public
 * URL. Uploads go to a UNIQUE per-upload path (stagedUploadPath) — never
 * over the live file — so a later row failure cannot change what clients
 * see. The returned URL is unique per upload, which replaces the old ?v=
 * cache-buster. Returns null when there is nothing to upload or the upload
 * fails — the caller keeps the profile local-only in that case.
 */
export async function uploadProfileMedia(
  client: Cloud,
  userId: string,
  kind: MediaKind,
  localUri: string | null,
  readNativeBase64?: (uri: string) => Promise<string | null>,
): Promise<string | null> {
  if (!client || !userId || !localUri) return null;
  try {
    const bytes = await readImageBytes(localUri, readNativeBase64);
    if (!bytes || bytes.length === 0) return null;
    const path = stagedUploadPath(userId, kind);
    const { error } = await client.storage.from(REALTOR_MEDIA_BUCKET).upload(
      path,
      bytes,
      { contentType: 'image/jpeg', upsert: false },
    );
    if (error) return null;
    // Unique path => unique URL: client surfaces drop the stale cached
    // image immediately, with no query-param cache-buster to maintain.
    return publicUrlForPath(client, path);
  } catch {
    return null;
  }
}

function isNotFoundStorageError(error: unknown): boolean {
  const message = String((error as { message?: unknown } | null)?.message ?? '');
  return /not found|does not exist|no such file/i.test(message);
}

/**
 * Delete one object from the realtor-media bucket by path (Sept 28, 2026,
 * Anuraj: profile/banner image removal).
 *
 * Loud, not best-effort: a failure throws so the caller surfaces it
 * (confirmed-or-loud) instead of reporting the removal silently
 * unconfirmed. A missing file counts as already deleted, never as a
 * failure — removal is idempotent, which also keeps retries safe.
 */
export async function deleteMediaAtPath(client: Cloud, path: string): Promise<void> {
  if (!client || !path) throw new Error('deleteMediaAtPath: no client or path');
  const { error } = await client.storage.from(REALTOR_MEDIA_BUCKET).remove([path]);
  if (error && !isNotFoundStorageError(error)) throw error;
}

/**
 * Delete the realtor's photo/banner at its legacy fixed path. Kept for the
 * pre-unique-path files and for tests; new code deletes by the path parsed
 * from the stored URL via deleteMediaAtPath.
 */
export async function deleteProfileMedia(
  client: Cloud,
  userId: string,
  kind: MediaKind,
): Promise<void> {
  await deleteMediaAtPath(client, storagePathFor(userId, kind));
}
