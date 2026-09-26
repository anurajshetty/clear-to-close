// Clear to Close — single managed profile-photo file (Sept 2026).
//
// Problem (Anuraj): the app stored whatever URI expo-image-picker returned,
// so every new pick left another file behind in the app's cache — old photo
// files piled up until the OS purged the cache on its own.
//
// Fix: after picking (and downscaling), the final image is copied into the
// app's own document directory under ONE fixed filename, overwriting any
// previous photo. Exactly one photo file exists at any time (the old photo
// is replaced, never accumulated), and it lives in Documents rather than
// Caches so the OS won't purge it out from under the app. Both the signup
// profile step and the edit-profile "Change photo" flow share ProfileForm,
// so both get this.
//
// Web: the same idea — the single downscaled image persists under one
// localStorage key, overwritten on every pick. (On web the manipulator
// returns a session-scoped blob: URI, so we convert to a data URI first —
// this also makes the web photo survive reloads.)
import { Platform } from 'react-native';
import {
  copyAsync,
  deleteAsync,
  documentDirectory,
} from 'expo-file-system/legacy';

export const MANAGED_PHOTO_FILENAME = 'profile-photo.jpg';
const WEB_PHOTO_KEY = 'ctc:profile-photo';

function managedDestUri(): string {
  return `${documentDirectory ?? ''}${MANAGED_PHOTO_FILENAME}`;
}

async function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Persist the final (downscaled) photo to the single managed location,
 * overwriting any previous photo. Returns the URI to store as photoUri.
 */
export async function saveManagedPhoto(sourceUri: string): Promise<string> {
  if (Platform.OS === 'web') {
    const blob = await (await fetch(sourceUri)).blob();
    const dataUri = await blobToDataUri(blob);
    localStorage.setItem(WEB_PHOTO_KEY, dataUri);
    return dataUri;
  }
  const dest = managedDestUri();
  await copyAsync({ from: sourceUri, to: dest });
  return dest;
}

/**
 * Best-effort cleanup of a stale photo file left behind by an earlier pick
 * (the old flow stored the picker's/manipulator's unique cache URIs).
 * The managed file itself is never deleted here — it gets overwritten.
 * Quiet: a missing or locked file is not an error worth surfacing.
 */
export async function deleteLegacyPhotoFile(uri: string | null): Promise<void> {
  if (!uri || Platform.OS === 'web') return;
  if (uri === managedDestUri() || !uri.startsWith('file://')) return;
  try {
    await deleteAsync(uri, { idempotent: true });
  } catch {
    // Quiet — the OS purges its cache eventually anyway.
  }
}

/** Read back the managed web photo (used by tests/diagnostics). */
export function readManagedWebPhoto(): string | null {
  if (Platform.OS !== 'web') return null;
  return localStorage.getItem(WEB_PHOTO_KEY);
}
