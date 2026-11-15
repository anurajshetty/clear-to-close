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
import { getSecureStore, getSupabase, type SecureStoreLike } from './supabase';
import { getDefaultKV } from './kv';
import type { KV } from './store';

const K_PUSH_ASKED = 'ctc:pushasked';
const K_PUSH_ASKED_REALTOR = 'ctc:pushasked:realtor';
// Notification Re-Ask (approved Nov 14, 2026): per-role ask state as
// one JSON value per role. The legacy ask-once keys above are read
// only as the migration seed (see readPushAskState).
const K_PUSH_ASK_STATE: Record<PushAskRole, string> = {
  realtor: 'ctc:pushask:realtor',
  client: 'ctc:pushask:client',
};

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
// Test seams for the registration-outcome test (Nov 10, 2026): the
// session lookup and the EAS project id are environment reads in
// production. `undefined` = no override.
let sessionUserIdOverride: (() => Promise<string | null>) | undefined;
/** Test seam: override the signed-in user lookup. */
export function __setSessionUserIdForTests(
  fn: (() => Promise<string | null>) | undefined,
): void {
  sessionUserIdOverride = fn;
}
let expoProjectIdOverride: string | null | undefined;
/** Test seam: override the Expo project id (null = simulate missing). */
export function __setExpoProjectIdForTests(id: string | null | undefined): void {
  expoProjectIdOverride = id;
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

// ---------------------------------------------------------------------
// Notification Re-Ask (approved design, Nov 14, 2026; supersedes the
// ask-once rule). The pre-prompt may re-ask on a 14-day cooldown, at
// most 4 total asks per role; the 4th ask offers "Don't ask again".
// One-time contextual asks (first team invite sent, client code-join)
// fire outside the cooldown but count toward the same cap. Permission
// granted stops everything. State is per role and device-local.
// ---------------------------------------------------------------------

export type PushAskRole = 'realtor' | 'client';
export type ContextualPushTrigger = 'realtor-invite' | 'client-code-join' | 'realtor-signup';

export interface PushAskState {
  /** Total sheets shown for this role (timed + contextual). */
  count: number;
  /** Epoch ms of the last TIMED show; null = never. Contextual shows
   *  deliberately do not move this (they are independent of the
   *  cooldown in both directions). */
  lastAskedAt: number | null;
  /** The final ask's "Don't ask again": no sheet ever shows again. */
  dontAskAgain: boolean;
  /** Once-per-device contextual trigger flags. */
  ctx: Record<ContextualPushTrigger, boolean>;
}

/** The sign-up / first-login trigger (amendment, Nov 14, 2026) is the
 *  one contextual ask that also starts the cooldown: it replaces the
 *  first timed ask on the deal list rather than stacking beside it. */

export const PUSH_ASK_CAP = 4;
export const PUSH_ASK_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export function defaultPushAskState(): PushAskState {
  return {
    count: 0,
    lastAskedAt: null,
    dontAskAgain: false,
    ctx: { 'realtor-invite': false, 'client-code-join': false, 'realtor-signup': false },
  };
}

function parsePushAskState(raw: string | null): PushAskState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<PushAskState>;
    if (typeof v !== 'object' || v === null) return null;
    return {
      count: typeof v.count === 'number' && Number.isFinite(v.count) ? v.count : 0,
      lastAskedAt:
        typeof v.lastAskedAt === 'number' && Number.isFinite(v.lastAskedAt)
          ? v.lastAskedAt
          : null,
      dontAskAgain: v.dontAskAgain === true,
      ctx: {
        'realtor-invite': v.ctx?.['realtor-invite'] === true,
        'client-code-join': v.ctx?.['client-code-join'] === true,
        'realtor-signup': v.ctx?.['realtor-signup'] === true,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Read one role's ask state. Legacy migration (spec section 5): with
 * no new-shape state stored, an ask-once-era flag ('1') seeds the
 * state as "asked long ago" — count 1, last-asked at the epoch, so
 * the device is immediately eligible for one fresh ask — and never
 * as don't-ask-again. The seed is derived on read until the first
 * recorded ask persists the new shape.
 */
export async function readPushAskState(role: PushAskRole, kv?: KV): Promise<PushAskState> {
  const store = kv ?? getDefaultKV();
  try {
    const parsed = parsePushAskState(await store.getItem(K_PUSH_ASK_STATE[role]));
    if (parsed) return parsed;
    const legacyKey = role === 'realtor' ? K_PUSH_ASKED_REALTOR : K_PUSH_ASKED;
    if ((await store.getItem(legacyKey)) === '1') {
      return { ...defaultPushAskState(), count: 1, lastAskedAt: 0 };
    }
  } catch {
    // fall through to the fresh default
  }
  return defaultPushAskState();
}

async function writePushAskState(role: PushAskRole, state: PushAskState, kv?: KV): Promise<void> {
  try {
    await (kv ?? getDefaultKV()).setItem(K_PUSH_ASK_STATE[role], JSON.stringify(state));
  } catch {
    // best-effort: a lost write only means the ask may repeat sooner
  }
}

/** Record a TIMED sheet show: count +1 and the cooldown restarts. */
export async function recordTimedAskShown(
  role: PushAskRole,
  now: number = Date.now(),
  kv?: KV,
): Promise<PushAskState> {
  const state = await readPushAskState(role, kv);
  const next = { ...state, count: state.count + 1, lastAskedAt: now };
  await writePushAskState(role, next, kv);
  return next;
}

/** Record a CONTEXTUAL sheet show: count +1 and the trigger is spent;
 *  the cooldown anchor (lastAskedAt) deliberately does not move. */
export async function recordContextualAskShown(
  role: PushAskRole,
  trigger: ContextualPushTrigger,
  kv?: KV,
): Promise<PushAskState> {
  const state = await readPushAskState(role, kv);
  const next = {
    ...state,
    count: state.count + 1,
    ctx: { ...state.ctx, [trigger]: true },
  };
  await writePushAskState(role, next, kv);
  return next;
}

/**
 * Record a SIGN-UP / FIRST-LOGIN sheet show: count +1, the trigger is
 * spent, AND the cooldown starts (lastAskedAt moves) — this ask
 * replaces the first timed ask on the deal list.
 */
export async function recordSignupAskShown(
  now: number = Date.now(),
  kv?: KV,
): Promise<PushAskState> {
  const state = await readPushAskState('realtor', kv);
  const next = {
    ...state,
    count: state.count + 1,
    lastAskedAt: now,
    ctx: { ...state.ctx, 'realtor-signup': true },
  };
  await writePushAskState('realtor', next, kv);
  return next;
}

/**
 * Sign-up / first-login eligibility (pure): stricter than the other
 * contextual asks — the OS permission must be UNDETERMINED (the
 * system prompt is still available). A denied device gets no login
 * sheet (the timed cadence and the Profile row handle it), a granted
 * device needs none. Once per device, under the cap, no stop flag.
 */
export function signupAskEligible(
  state: PushAskState,
  permission: PushPermissionState,
): boolean {
  if (permission !== 'undetermined') return false;
  if (state.dontAskAgain) return false;
  if (state.count >= PUSH_ASK_CAP) return false;
  if (state.ctx['realtor-signup']) return false;
  return true;
}

/** The final ask's "Don't ask again": permanent per-role stop. */
export async function markDontAskAgain(role: PushAskRole, kv?: KV): Promise<void> {
  const state = await readPushAskState(role, kv);
  await writePushAskState(role, { ...state, dontAskAgain: true }, kv);
}

/**
 * Timed-sheet eligibility (pure): permission not granted, no stop
 * flag, under the cap, and the 14-day cooldown since the last timed
 * ask has elapsed (or no timed ask yet / legacy-seeded epoch).
 */
export function timedAskEligible(
  state: PushAskState,
  permission: PushPermissionState,
  now: number,
): boolean {
  if (permission === 'granted') return false;
  if (state.dontAskAgain) return false;
  if (state.count >= PUSH_ASK_CAP) return false;
  if (state.lastAskedAt !== null && now - state.lastAskedAt < PUSH_ASK_COOLDOWN_MS) {
    return false;
  }
  return true;
}

/**
 * Contextual-sheet eligibility (pure): the trigger has never fired on
 * this device, permission is not granted, no stop flag, and the
 * shared 4-ask cap has room. The cooldown does NOT gate contextual
 * asks (spec section 2).
 */
export function contextualAskEligible(
  state: PushAskState,
  permission: PushPermissionState,
  trigger: ContextualPushTrigger,
): boolean {
  if (permission === 'granted') return false;
  if (state.dontAskAgain) return false;
  if (state.count >= PUSH_ASK_CAP) return false;
  if (state.ctx[trigger]) return false;
  return true;
}

/** True when the NEXT show for this state is the 4th (final) ask —
 *  the only show that carries the "Don't ask again" tertiary. */
export function isFinalAsk(state: PushAskState): boolean {
  return state.count === PUSH_ASK_CAP - 1;
}

// Contextual trigger bus: the invite-send and redeem success paths
// call notifyContextualPushAsk; PushGate (mounted at the layout)
// subscribes and owns presentation, so the success states are never
// blocked or delayed by the sheet.
type ContextualAskListener = (trigger: ContextualPushTrigger) => void;
const contextualAskListeners = new Set<ContextualAskListener>();

export function onContextualPushAsk(listener: ContextualAskListener): () => void {
  contextualAskListeners.add(listener);
  return () => {
    contextualAskListeners.delete(listener);
  };
}

export function notifyContextualPushAsk(trigger: ContextualPushTrigger): void {
  for (const listener of [...contextualAskListeners]) {
    try {
      listener(trigger);
    } catch {
      // a listener failure never reaches the success path
    }
  }
}

/**
 * Back-control decision for screens that are normally reached by an
 * in-app PUSH but can also be a push-notification LANDING (Nov 10,
 * 2026): PushGate routes taps with router.replace, so a landing has
 * NO back stack beneath it (cold start: the landing is the only
 * route; warm start: replace swapped the current screen out) and a
 * bare router.back() is a dead control — the activity screen's
 * "Details" button on a member-activity push entry, and the escrow
 * detail screen's own back controls on its (more common) push
 * landings. The decision: go back when a back stack exists (in-app
 * behavior unchanged), else REPLACE to the control's own target so
 * the stack is constructed (landing -> target, system back from
 * there behaves exactly like any other cold-entered screen).
 */
export type BackFallbackAction =
  | { type: 'back' }
  | { type: 'replace'; href: string };

export function backFallbackAction(
  canGoBack: boolean,
  fallbackHref: string,
): BackFallbackAction {
  return canGoBack ? { type: 'back' } : { type: 'replace', href: fallbackHref };
}


/**
 * Where a push tap lands, by the tapped payload's role. Realtor pushes
 * (P1) carry role 'realtor' and open the realtor escrow screen; client
 * pushes open the role's client home (clientHomeRoute).
 *
 * Team Access (Oct 2026): when the payload also carries a team `kind`,
 * the kind wins — see teamPushTapRoute. Callers that never pass a kind
 * keep the exact pre-team behavior.
 */
export function pushTapRoute(escrowId: string, role: string, kind?: string | null): string {
  if (kind) {
    const teamRoute = teamPushTapRoute(kind, escrowId);
    if (teamRoute) return teamRoute;
  }
  if (role === 'realtor') return `/escrow/${escrowId}`;
  return clientHomeRoute(escrowId, role);
}

/**
 * Team Access push tap routes (Oct 2026, migration 0044 events):
 * - 'team_invite_received' lands on the deal-list home, where the
 *   pending-invite card lives (there is no escrow to open yet).
 * - 'team_invite_accepted' opens the escrow the invite was for.
 * - 'member_step_activity' opens the escrow's home (detail) screen
 *   directly — the checklist view (Anuraj, Nov 10, 2026: NOT the
 *   activity timeline; supersedes the Oct 2026 tap-opens-Activity
 *   rule).
 * Returns null for anything else so callers fall back to role routing.
 */
export function teamPushTapRoute(kind: string, escrowId: string): string | null {
  switch (kind) {
    case 'team_invite_received':
      return '/';
    case 'team_invite_accepted':
      return `/escrow/${escrowId}`;
    case 'member_step_activity':
      return `/escrow/${escrowId}`;
    default:
      return null;
  }
}

/**
 * Extract the deep-link target from a notification response. Returns null
 * for malformed payloads so a bad push can never misroute.
 */
export function escrowRouteFromResponse(response: unknown): {
  escrowId: string;
  role: 'buyer' | 'seller' | 'tc' | 'realtor';
  /** Team Access event kind from the payload (null for non-team pushes). */
  kind: string | null;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (response as any)?.notification?.request?.content?.data ?? {};
    const escrowId = typeof data.escrowId === 'string' ? data.escrowId : '';
    if (!escrowId) return null;
    // 'realtor' is preserved (P1): realtor pushes carry it and route to
    // the realtor escrow screen via pushTapRoute. Anything unrecognized
    // keeps the buyer default.
    const role =
      data.role === 'seller'
        ? 'seller'
        : data.role === 'tc'
          ? 'tc'
          : data.role === 'realtor'
            ? 'realtor'
            : 'buyer';
    const kind = typeof data.kind === 'string' ? data.kind : null;
    return { escrowId, role, kind };
  } catch {
    return null;
  }
}

/**
 * Client home route for a push tap, by the tapped device's link role.
 * All three client roles have their own home (P0 fix, Oct 15 2026: TC
 * taps used to fall through to the buyer home because PushGate mapped
 * every non-seller role to buyer). Unknown roles keep the buyer
 * default, matching escrowRouteFromResponse.
 */
export function clientHomeRoute(escrowId: string, role: string): string {
  const segment = role === 'seller' ? 'seller' : role === 'tc' ? 'tc' : 'buyer';
  return `/client/${segment}/${escrowId}`;
}

const CLIENT_HOME_PATH_RE = /^\/client\/(buyer|seller|tc)\/[^/]+$/;

/**
 * Is this pathname a client escrow home (any of the three roles)?
 * Gates the push pre-prompt: it may only appear over a client's own
 * escrow home. P0.4 (Oct 15, 2026): TC homes included — TCs are
 * first-class push recipients under side-aware targeting, and the
 * pre-prompt copy is role-neutral ("your realtor checks off a step"),
 * so the identical sheet serves all three roles.
 */
export function isClientHomePath(pathname: string): boolean {
  return CLIENT_HOME_PATH_RE.test(pathname);
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

// ------------------------------------------------------- realtor tokens --
// P0 (Oct 15, 2026; migration 0038): the signed-in realtor's OWN devices
// register through the authenticated register_push_token_for_user —
// identity is auth.uid() server-side; the app never sends a user id.
// Registration mirrors the client self-heal: it runs while OS permission
// is granted and re-runs on launch, so rotations/reinstalls heal. No new
// permission ask is shown to realtors in P0 (copy decision, later phase).

const K_PUSH_REALTOR_UNREG_PENDING = 'ctc:push:realtor-unreg-pending';

interface RealtorUnregPending {
  deviceId: string;
  token: string;
}

/**
 * Where the pending pair lives (auditor v2 fix, Oct 15 2026): an
 * explicit test KV wins; otherwise SecureStore (the pair is a live
 * push credential — it does not belong in plain AsyncStorage); the
 * AsyncStorage KV is only the fallback where SecureStore does not
 * exist (web). Nothing has shipped with the queued pair yet, so no
 * legacy-copy migration is owed.
 */
export function resolveRealtorPendingStore(
  kv?: KV,
  secure?: SecureStoreLike | null,
): KV {
  if (kv) return kv;
  const ss = secure !== undefined ? secure : getSecureStore();
  if (ss) {
    return {
      getItem: (k: string) => ss.getItemAsync(k),
      setItem: (k: string, v: string) => ss.setItemAsync(k, v),
      removeItem: (k: string) => ss.deleteItemAsync(k),
    };
  }
  return getDefaultKV();
}

/** Queue (or clear) the boot retry for a failed sign-out unregister. */
export async function setRealtorUnregisterPending(
  pending: RealtorUnregPending | null,
  kv?: KV,
): Promise<void> {
  try {
    const store = resolveRealtorPendingStore(kv);
    if (pending === null) {
      await store.removeItem(K_PUSH_REALTOR_UNREG_PENDING);
    } else {
      await store.setItem(K_PUSH_REALTOR_UNREG_PENDING, JSON.stringify(pending));
    }
  } catch {
    // best-effort; the authenticated path is the primary rail
  }
}

export async function getRealtorUnregisterPending(
  kv?: KV,
): Promise<RealtorUnregPending | null> {
  try {
    const raw = await resolveRealtorPendingStore(kv).getItem(K_PUSH_REALTOR_UNREG_PENDING);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RealtorUnregPending>;
    if (typeof parsed.deviceId === 'string' && typeof parsed.token === 'string') {
      return { deviceId: parsed.deviceId, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Realtor push registration outcomes (Nov 10, 2026): every registration
 * attempt records its outcome here — registered, skipped (with the
 * guard that stopped it), or failed (with the error) — in a bounded KV
 * ring buffer, mirroring the conflict log's diagnostics pattern
 * (cloudSync logConflict). INTERNAL only: no UI reads this; it exists
 * so a silent no-token state is diagnosable instead of invisible (the
 * member-activity push incident: registration had only ever fired at
 * PushGate bootstrap, and every failure was swallowed by a catch).
 * Best-effort: recording never throws and never blocks registration.
 */
export interface RealtorPushRegistrationRecord {
  at: string;
  status: 'registered' | 'skipped' | 'failed';
  /** For status 'skipped': which guard stopped the attempt. */
  reason?: string;
  /** For status 'failed': the error text. */
  error?: string;
}

const K_PUSH_REGISTRATION_LOG = 'ctc:push-registration-log';
const MAX_PUSH_REGISTRATION_LOG = 50;

// One memoized backend for the log: getDefaultKV() hands back a fresh
// in-memory store per call outside native, which would scatter the
// ring across instances; on device every handle wraps the same
// AsyncStorage, so memoizing is behavior-identical there.
let registrationLogKv: KV | null = null;
function getRegistrationLogKv(): KV {
  if (!registrationLogKv) registrationLogKv = getDefaultKV();
  return registrationLogKv;
}

async function recordRealtorPushRegistration(
  rec: Omit<RealtorPushRegistrationRecord, 'at'>,
): Promise<void> {
  try {
    const kv = getRegistrationLogKv();
    const raw = await kv.getItem(K_PUSH_REGISTRATION_LOG);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const list: RealtorPushRegistrationRecord[] = Array.isArray(parsed) ? parsed : [];
    list.push({ ...rec, at: new Date().toISOString() });
    while (list.length > MAX_PUSH_REGISTRATION_LOG) list.shift();
    await kv.setItem(K_PUSH_REGISTRATION_LOG, JSON.stringify(list));
  } catch {
    // Diagnostics only — never break registration.
  }
}

/** Read the realtor push registration log (newest last). */
export async function readRealtorPushRegistrationLog(): Promise<
  RealtorPushRegistrationRecord[]
> {
  try {
    const raw = await getRegistrationLogKv().getItem(K_PUSH_REGISTRATION_LOG);
    const parsed: unknown = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Register this device's Expo token for the signed-in realtor (no-op when
 * signed out, on web, or while permission is not granted). Returns true
 * when the server holds a live user-bound row for this device. Every
 * attempt's outcome is recorded (see RealtorPushRegistrationRecord).
 */
export async function registerRealtorPushToken(): Promise<boolean> {
  const finish = async (
    ok: boolean,
    rec: Omit<RealtorPushRegistrationRecord, 'at'>,
  ): Promise<boolean> => {
    await recordRealtorPushRegistration(rec);
    return ok;
  };
  const N = loadNotifications();
  if (!N) return finish(false, { status: 'skipped', reason: 'no-notifications-module' });
  try {
    if ((await getPushPermission()) !== 'granted') {
      return finish(false, { status: 'skipped', reason: 'permission-not-granted' });
    }
    const sessionUserId = sessionUserIdOverride
      ? await sessionUserIdOverride()
      : await auth.getSessionUserId();
    if (sessionUserId === null) {
      return finish(false, { status: 'skipped', reason: 'signed-out' });
    }
    const projectId =
      expoProjectIdOverride !== undefined ? expoProjectIdOverride : getExpoProjectId();
    if (!projectId) {
      console.warn('[push] missing EAS projectId: realtor token registration skipped');
      return finish(false, { status: 'skipped', reason: 'no-project-id' });
    }
    const tokenResp = await N.getExpoPushTokenAsync({ projectId });
    const token = tokenResp?.data;
    if (!token) return finish(false, { status: 'skipped', reason: 'no-token' });
    const deviceId = await auth.getDeviceId();
    const client = getClient();
    if (!client) return finish(false, { status: 'skipped', reason: 'no-client' });
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Distinct authenticated function (0038 v2, auditor: never an
    // overload of the client register_push_token).
    const { data, error } = await client.rpc('register_push_token_for_user', {
      p_device_id: deviceId,
      p_token: token,
      p_timezone: timeZone,
    });
    if (error) {
      return finish(false, {
        status: 'failed',
        error: (error as { message?: string })?.message ?? String(error),
      });
    }
    if ((data as { ok?: boolean } | null)?.ok !== true) {
      return finish(false, {
        status: 'failed',
        error: 'register_push_token_for_user returned not-ok',
      });
    }
    return finish(true, { status: 'registered' });
  } catch (err) {
    return finish(false, { status: 'failed', error: String(err) });
  }
}

/**
 * Drop this device's realtor token row during logout — MUST run while
 * the session is still live (auditor requirement 6: identity is derived
 * server-side from the JWT). If the call fails, the (deviceId, token)
 * pair is queued locally so the next boot can retry by possession;
 * a signed-out device must never keep receiving the realtor's pushes
 * silently. No-op when there is no session (nothing authenticated to
 * unregister) or on web.
 */
export async function unregisterRealtorPushToken(): Promise<void> {
  const N = loadNotifications();
  if (!N) return;
  try {
    if ((await auth.getSessionUserId()) === null) return;
    const deviceId = await auth.getDeviceId();
    const client = getSupabase();
    if (!client) return;
    const { data, error } = await client.rpc('unregister_push_token_for_user', {
      p_device_id: deviceId,
    });
    if (!error && (data as { ok?: boolean } | null)?.ok === true) {
      await setRealtorUnregisterPending(null);
      return;
    }
    // Failed: queue the possession retry with the token as minted now,
    // while this device still holds it.
    const projectId = getExpoProjectId();
    const tokenResp = projectId
      ? await N.getExpoPushTokenAsync({ projectId }).catch(() => null)
      : null;
    const token = tokenResp?.data;
    if (token) {
      await setRealtorUnregisterPending({ deviceId, token });
    }
  } catch {
    // best-effort; a queued retry (if token minting worked) covers us
  }
}

/**
 * Boot retry for a queued sign-out unregister (auditor requirement 6).
 * Possession is the credential: the exact (device_id, expo_push_token)
 * pair deletes at most the one user-bound row matching both (migration
 * 0038, pending the auditor's line-level pass on that RPC). Clears the
 * queue only on a server-confirmed delete.
 */
export async function retryPendingRealtorUnregister(): Promise<void> {
  const pending = await getRealtorUnregisterPending();
  if (!pending) return;
  try {
    const client = getSupabase();
    if (!client) return;
    const { data, error } = await client.rpc(
      'unregister_push_token_for_user_by_possession',
      { p_device_id: pending.deviceId, p_token: pending.token },
    );
    if (!error && (data as { ok?: boolean } | null)?.ok === true) {
      await setRealtorUnregisterPending(null);
    }
  } catch {
    // stays queued for the next boot
  }
}

/**
 * Foreground suppression + tap-to-deep-link. The handler suppresses the
 * banner/list/sound while the app is foreground (the Latest card shows the
 * update); background/killed taps route to the client's escrow home via
 * the notification's { escrowId, role } data. Also handles the cold-start
 * case (tap launched the app from killed).
 */
export function setupPushHandling(
  onOpenEscrow: (escrowId: string, role: string, kind?: string | null) => void,
): () => void {
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
    if (target) onOpenEscrow(target.escrowId, target.role, target.kind);
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
