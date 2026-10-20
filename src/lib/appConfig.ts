// Clear to Close — public app configuration (Oct 20, 2026).
//
// The client app link used by invite shares lives in the Supabase
// `app_config` table (migration 0043) so it stays a first-party link
// we control and can evolve without a rebuild (at store launch the
// landing page gains per-platform routing; the value may not change
// at all). This module fetches it at boot and on foreground into an
// in-memory cache; the share payload reads the cache.
//
// Fallback chain (pinned by tests): a cached, VALIDATED value wins;
// anything else — fetch failure, missing row, malformed or non-https
// value — falls back to the built-in CLIENT_APP_LINK constant. The
// value is public by design (it goes into shared messages), and the
// table is read-only to clients (RLS: SELECT for anon/authenticated,
// no client writes).
import { getSupabase } from './supabase';
import { CLIENT_APP_LINK } from './shareCopy';

let cachedLink: string | null = null;

/** A usable client app link is a non-empty https URL. Anything else is ignored. */
export function isValidClientAppLink(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    return new URL(trimmed).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The effective link right now: the validated cache, else the built-in fallback. */
export function getClientAppLink(): string {
  return cachedLink ?? CLIENT_APP_LINK;
}

async function fetchConfiguredLink(): Promise<string | null> {
  const client = getSupabase();
  if (!client) return null;
  const { data, error } = await client
    .from('app_config')
    .select('value')
    .eq('key', 'client_app_link')
    .maybeSingle();
  if (error || !data) return null;
  const value = (data as { value?: unknown }).value;
  return typeof value === 'string' ? value : null;
}

/**
 * Refresh the cache from app_config. Only a validated value replaces
 * the cache; failures and invalid values leave the current effective
 * link untouched. The fetcher is injectable for tests.
 */
export async function refreshClientAppLink(
  fetchValue: () => Promise<string | null> = fetchConfiguredLink,
): Promise<string> {
  try {
    const value = await fetchValue();
    if (isValidClientAppLink(value)) {
      cachedLink = value.trim();
    }
  } catch {
    // Offline or unconfigured: the cached/fallback link stands.
  }
  return getClientAppLink();
}

/** Test seam: clear the in-memory cache. */
export function resetClientAppLinkCache(): void {
  cachedLink = null;
}
