// Clear to Close — client push notifications (Expo Push, native only).
//
// Transport: DB trigger -> pg_net -> Edge Function `send-client-push` ->
// Expo Push API. This module is the CLIENT side: permission pre-prompt,
// token registration, foreground suppression, and tap-to-deep-link.
//
// Web is out of push scope (Expo Push targets native tokens): every entry
// point no-ops on web. expo-notifications is require()d lazily (guarded by
// try/catch) so this module imports cleanly in node test runs and in the
// web bundle.
//
// Forward-progress only (Anuraj's rule): the server-side trigger fires on
// step check-offs, new custom steps, and target-close-date changes. Unchecks
// never produce a push. Dedupe is client-side: the notification handler
// suppresses the banner while the app is foreground (the Latest card covers
// it); the server always sends, which is race-free.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: (id: string) => any;

import { auth } from './auth';
import { getSupabase } from './supabase';
import { getDefaultKV } from './kv';
import type { KV } from './store';

const K_PUSH_ASKED = 'ctc:pushasked';

// Platform without a static react-native import: the unit tests run in node,
// where react-native is unavailable. The app bundle resolves require() fine.
let platformOverride: string | null = null;
/** Test seam: force a platform in node tests. */
export function __setPlatformForTests(os: string | null): void {
  platformOverride = os;
}
// Test seams for the M2 device-binding regression test (node has no
// expo-notifications and no Supabase client). `undefined` = no override.
let notificationsOverride: any | undefined;
/** Test seam: inject the notifications module in node tests. */
export function __setNotificationsForTests(n: any | null): void {
  notificationsOverride = n;
}
let supabaseOverride: any | undefined;
/** Test seam: inject the Supabase client in node tests. */
export function __setSupabaseForTests(c: any | null): void {
  supabaseOverride = c;
}
/** Test-seam-aware client getter (production: the real Supabase client). */
function getClient(): any | null {
  if (supabaseOverride !== undefined) return supabaseOverride;
  return getSupabase();
}
function platformOS(): string {
  if (platformOverride) return platformOverride;
  try {
    const mod = require('react-native');
    return mod?.Platform?.OS ?? 'ios';
  } catch {
    return 'ios';
  }
}
const isWeb = (): boolean => platformOS() === 'web';

/** Lazy, guarded access to expo-notifications. Null on web / node. */
export function loadNotifications(): any | null {
  if (notificationsOverride !== undefined) return notificationsOverride;
  if (isWeb()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('expo-notifications');
  } catch {
    return null;
  }
}

/** EAS project id (needed for getExpoPushTokenAsync on standalone builds). */
export function getExpoProjectId(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Constants = require('expo-constants').default ?? require('expo-constants');
    const pid = Constants?.expoConfig?.extra?.eas?.projectId;
    return typeof pid === 'string' && pid ? pid : null;
  } catch {
    return null;
  }
}

export type PushPermissionState = 'granted' | 'denied' | 'undetermined';

export async function getPushPermission(): Promise<PushPermissionState> {
  const N = loadNotifications();
  if (!N) return 'undetermined';
  try {
    const { status } = await N.getPermissionsAsync();
    return status === 'granted' ? 'granted' : status === 'denied' ? 'denied' : 'undetermined';
  } catch {
    return 'undetermined';
  }
}

export async function requestPushPermission(): Promise<boolean> {
  const N = loadNotifications();
  if (!N) return false;
  try {
    const { status } = await N.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

export async function hasBeenAskedPush(kv?: KV): Promise<boolean> {
  try {
    return ((await (kv ?? getDefaultKV()).getItem(K_PUSH_ASKED)) === '1');
  } catch {
    return false;
  }
}

export async function markPushAsked(kv?: KV): Promise<void> {
  try {
    await (kv ?? getDefaultKV()).setItem(K_PUSH_ASKED, '1');
  } catch {
    // best-effort
  }
}

/**
 * Pure pre-prompt eligibility (ask-once, Anuraj's rule): the prompt shows
 * only for a client whose OS permission is still undetermined and who has
 * never been asked. Denied/granted/realtor never see it.
 */
export function shouldShowPrePrompt(args: {
  role: string | null;
  hasLink: boolean;
  asked: boolean;
  permission: PushPermissionState;
}): boolean {
  return (
    args.role === 'client' &&
    args.hasLink &&
    !args.asked &&
    args.permission === 'undetermined'
  );
}

/**
 * Extract the deep-link target from a notification response. Returns null
 * for malformed payloads so a bad push can never misroute.
 */
export function escrowRouteFromResponse(response: unknown): {
  escrowId: string;
  role: 'buyer' | 'seller' | 'tc';
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (response as any)?.notification?.request?.content?.data ?? {};
    const escrowId = typeof data.escrowId === 'string' ? data.escrowId : '';
    if (!escrowId) return null;
    const role = data.role === 'seller' ? 'seller' : data.role === 'tc' ? 'tc' : 'buyer';
    return { escrowId, role };
  } catch {
    return null;
  }
}

/**
 * Register this device's Expo push token for EVERY client link on the
 * device, one token row per link. Multi-escrow (Sept 28, 2026): the token
 * identity is link-scoped — registering a second escrow's link adds a row
 * instead of replacing the first escrow's registration. Re-run on every
 * launch while granted: reinstalls and token rotations self-heal. Returns
 * true when at least one link's token is live server-side.
 */
export async function registerPushToken(): Promise<boolean> {
  const N = loadNotifications();
  if (!N) return false;
  try {
    if ((await getPushPermission()) !== 'granted') return false;
    const links = await auth.getClientLinks();
    if (!links.length) return false;
    const projectId = getExpoProjectId();
    if (!projectId) {
      // Standalone builds need extra.eas.projectId (set by `eas init`).
      // Without it no Expo token can be minted; README documents the step.
      console.warn('[push] missing EAS projectId: push token registration skipped');
      return false;
    }
    const tokenResp = await N.getExpoPushTokenAsync({ projectId });
    const token = tokenResp?.data;
    if (!token) return false;
    const deviceId = await auth.getDeviceId();
    const client = getSupabase();
    if (!client) return false;
    // The SAME Expo token registers once per link: each escrow gets its
    // own row (migration 0022: upsert on (device_id, link_id)). One link's
    // failure must not block the others.
    // IANA zone drives quiet-hours + day counting (0024+). Web/node
    // fall back to the resolved offset zone if Intl is unavailable.
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let anyOk = false;
    for (const link of links) {
      try {
        const { data, error } = await client.rpc('register_push_token', {
          p_link_id: link.linkId,
          p_device_id: deviceId,
          p_token: token,
          p_timezone: timeZone,
        });
        if (!error && (data as { ok?: boolean } | null)?.ok === true) anyOk = true;
      } catch {
        // One link's failure must not block the others.
      }
    }
    return anyOk;
  } catch {
    return false;
  }
}

/**
 * Drop ONE link's token row (multi-escrow, Sept 28, 2026): the dead
 * link's pushes stop without touching the device's other escrows'
 * registrations. The device-wide unregisterPushToken below still exists
 * for start-over / opt-out.
 *
 * M2 staged lockstep (Oct 1, 2026): passes this device's id so the server
 * binds the delete to the device/link pair (Stage 2). The server keeps a
 * default-null p_device_id for old app versions (Stage 1).
 */
export async function unregisterPushTokenForLink(linkId: string): Promise<void> {
  const N = loadNotifications();
  if (!N) return;
  try {
    const deviceId = await auth.getDeviceId();
    const client = getClient();
    if (!client) return;
    await client.rpc('unregister_push_token_for_link', {
      p_link_id: linkId,
      p_device_id: deviceId,
    });
  } catch {
    // best-effort
  }
}

/** Drop this device's tokens (client start-over, opt-out). */
export async function unregisterPushToken(): Promise<void> {
  const N = loadNotifications();
  if (!N) return;
  try {
    const deviceId = await auth.getDeviceId();
    const client = getSupabase();
    if (!client) return;
    await client.rpc('unregister_push_token', { p_device_id: deviceId });
  } catch {
    // best-effort
  }
}

/**
 * Foreground suppression + tap-to-deep-link. The handler suppresses the
 * banner/list/sound while the app is foreground (the Latest card shows the
 * update); background/killed taps route to the client's escrow home via
 * the notification's { escrowId, role } data. Also handles the cold-start
 * case (tap launched the app from killed).
 */
export function setupPushHandling(onOpenEscrow: (escrowId: string, role: string) => void): () => void {
  const N = loadNotifications();
  if (!N) return () => {};
  const cleanups: Array<() => void> = [];
  try {
    N.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
  } catch {
    // older SDKs: best-effort
  }

  const routeResponse = (response: unknown) => {
    const target = escrowRouteFromResponse(response);
    if (target) onOpenEscrow(target.escrowId, target.role);
  };

  try {
    const sub = N.addNotificationResponseReceivedListener(routeResponse);
    cleanups.push(() => {
      try {
        sub.remove();
      } catch {
        // ignore
      }
    });
    // Cold start: the tap launched the app from killed.
    N.getLastNotificationResponseAsync()
      .then((resp: any) => {
        if (resp) routeResponse(resp);
      })
      .catch(() => {});
  } catch {
    // ignore
  }

  return () => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  };
}
