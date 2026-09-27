// Clear to Close — realtor media upload to Supabase Storage (Sept 2026,
// Anuraj-approved): the profile photo and banner upload to the public
// `realtor-media` bucket so client devices can see them. Previously photos
// stayed device-local.
//
// Path convention (contractual — matches migration 0014):
//   <userId>/photo.jpg
//   <userId>/banner.jpg
// Single overwrite files: every upload upserts the same path.
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

export function storagePathFor(userId: string, kind: MediaKind): string {
  return `${userId}/${kind === 'photo' ? 'photo.jpg' : 'banner.jpg'}`;
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
 * URL. Returns null when there is nothing to upload or the upload fails —
 * the caller keeps the profile local-only in that case.
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
    const { error } = await client.storage.from(REALTOR_MEDIA_BUCKET).upload(
      storagePathFor(userId, kind),
      bytes,
      { contentType: 'image/jpeg', upsert: true },
    );
    if (error) return null;
    return publicUrlFor(client, userId, kind);
  } catch {
    return null;
  }
}
