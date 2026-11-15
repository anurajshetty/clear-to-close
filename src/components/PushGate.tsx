// Clear to Close — PushGate: client-side push bootstrap + permission
// pre-prompt sheets.
//
// Mounted once in app/_layout.tsx after boot. Web is a safe no-op (every
// helper in src/lib/push.ts guards Platform.OS === 'web').
//
// Notification Re-Ask (approved Nov 14, 2026; supersedes ask-once): the
// pre-prompt sheet may re-show on a 14-day cooldown, at most 4 total
// asks per role (realtor and client tracked separately), and the 4th
// ask adds a "Don't ask again" stop. One-time contextual asks follow
// the first team invite and the client code-join, outside the cooldown
// but inside the same cap. The primary button is two-state: while the
// OS permission is undetermined it runs the system prompt; once denied
// (the OS will never show the dialog again) it becomes "Open Settings".
// Permission granted stops every sheet; the token re-registers on
// every launch so reinstalls/rotations self-heal. At most one sheet
// shows per app session.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { auth } from '../lib/auth';
import {
  contextualAskEligible,
  getPushPermission,
  isClientHomePath,
  isFinalAsk,
  loadNotifications,
  markDontAskAgain,
  onContextualPushAsk,
  pushTapRoute,
  readPushAskState,
  recordContextualAskShown,
  recordSignupAskShown,
  recordTimedAskShown,
  registerPushToken,
  registerRealtorPushToken,
  requestPushPermission,
  retryPendingRealtorUnregister,
  setupPushHandling,
  signupAskEligible,
  timedAskEligible,
  type ContextualPushTrigger,
  type PushAskRole,
  type PushPermissionState,
} from '../lib/push';
import { store } from '../lib/store-instance';
import { PrimaryButton, SecondaryButton, Sheet } from './ui';
import { colors } from '../theme';

interface SheetKind {
  role: PushAskRole;
  variant: 'timed' | ContextualPushTrigger;
  permission: PushPermissionState;
  finalAsk: boolean;
  /** Client timed copy personalization (the realtor's first name). */
  clientFirst: string;
}

const SETTLE_MS = 1200;

export function PushGate(): React.ReactElement | null {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const evaluated = useRef(false);
  const realtorEvaluated = useRef(false);
  // One sheet per app session, whichever path wins; the ask is recorded
  // only when a sheet actually shows.
  const sheetShown = useRef(false);

  const routeToEscrow = useCallback(
    (escrowId: string, role: string, kind?: string | null) => {
      router.replace(pushTapRoute(escrowId, role, kind) as never);
    },
    [router],
  );

  /** Show a sheet if none has shown this session; returns success. */
  const present = useCallback((kind: SheetKind): boolean => {
    if (sheetShown.current) return false;
    sheetShown.current = true;
    setSheet(kind);
    return true;
  }, []);

  // One-time native bootstrap: foreground suppression + tap routing
  // (warm + cold start), and token refresh while granted.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!loadNotifications()) return;
    const cleanup = setupPushHandling(routeToEscrow);
    // Boot retry for a sign-out unregister that failed last session
    // (auditor P0 requirement 6) — possession-based, self-guarded.
    void retryPendingRealtorUnregister().catch(() => {});
    void auth
      .getClientLinks()
      .then((links) => {
        if (links.length > 0) return registerPushToken();
        return false;
      })
      .catch(() => false);
    // Realtor token self-heal on launch (P0): registers this device for
    // the signed-in realtor while permission is granted; self-guards
    // when signed out or ungranted.
    void registerRealtorPushToken().catch(() => false);
    return cleanup;
  }, [routeToEscrow]);

  // Timed sheet, client: on the client's escrow home, role client with
  // a link, re-ask eligible.
  useEffect(() => {
    if (evaluated.current) return;
    if (Platform.OS === 'web') return;
    if (!isClientHomePath(pathname)) return;
    evaluated.current = true;
    let active = true;
    (async () => {
      try {
        const [role, links, state, permission] = await Promise.all([
          auth.getRole(),
          auth.getClientLinks(),
          readPushAskState('client'),
          getPushPermission(),
        ]);
        if (role !== 'client' || links.length === 0) return;
        if (!timedAskEligible(state, permission, Date.now())) return;
        const profile = await store.getClientProfile(links[0]?.escrowId ?? null).catch(() => null);
        const first = (profile?.name ?? '').trim().split(/\s+/)[0] ?? '';
        // Small settle delay so the home/celebration lands first.
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        if (!active) return;
        if (
          present({
            role: 'client',
            variant: 'timed',
            permission,
            finalAsk: isFinalAsk(state),
            clientFirst: first,
          })
        ) {
          await recordTimedAskShown('client');
        }
      } catch {
        // never block the client home
      }
    })();
    return () => {
      active = false;
    };
  }, [pathname, present]);

  // Timed sheet, realtor: signed-in realtor on the deal list, re-ask
  // eligible. Mirrors the client rule with its own per-role state.
  useEffect(() => {
    if (realtorEvaluated.current) return;
    if (Platform.OS === 'web') return;
    if (pathname !== '/') return;
    realtorEvaluated.current = true;
    let active = true;
    (async () => {
      try {
        const [role, sessionUserId, state, permission] = await Promise.all([
          auth.getRole(),
          auth.getSessionUserId(),
          readPushAskState('realtor'),
          getPushPermission(),
        ]);
        if (role !== 'realtor' || sessionUserId === null) return;
        if (!timedAskEligible(state, permission, Date.now())) return;
        // Small settle delay so the deal list lands first.
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        if (!active) return;
        if (
          present({
            role: 'realtor',
            variant: 'timed',
            permission,
            finalAsk: isFinalAsk(state),
            clientFirst: '',
          })
        ) {
          await recordTimedAskShown('realtor');
        }
      } catch {
        // never block the deal list
      }
    })();
    return () => {
      active = false;
    };
  }, [pathname, present]);

  // Sign-up / first-login ask (amendment, Nov 14, 2026): the login and
  // signup screens fire the trigger on an actual sign-up completion or
  // explicit login (session restore never fires it). Presentation
  // waits until the user has landed on the deal list — the auth flow
  // itself gains no step — so the pending flag rides across the
  // profile-create detour and is attempted on every landing on '/'.
  const pendingSignup = useRef(false);
  const signupAttempting = useRef(false);
  const pathnameRef = useRef(pathname);
  const attemptSignup = useCallback(async () => {
    if (!pendingSignup.current || signupAttempting.current) return;
    if (pathnameRef.current !== '/') return;
    signupAttempting.current = true;
    try {
      const [state, permission] = await Promise.all([
        readPushAskState('realtor'),
        getPushPermission(),
      ]);
      if (!signupAskEligible(state, permission)) {
        // Denied/granted/capped/stopped/spent: this trigger never
        // fires for this sign-in; the timed cadence owns the rest.
        pendingSignup.current = false;
        return;
      }
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      if (pathnameRef.current !== '/') return; // navigated away; stay pending
      if (
        present({
          role: 'realtor',
          variant: 'realtor-signup',
          permission,
          finalAsk: isFinalAsk(state),
          clientFirst: '',
        })
      ) {
        pendingSignup.current = false;
        await recordSignupAskShown();
      } else {
        // Another sheet took this session; a later login can retry.
        pendingSignup.current = false;
      }
    } catch {
      // never block the deal list
    } finally {
      signupAttempting.current = false;
    }
  }, [present]);

  useEffect(() => {
    pathnameRef.current = pathname;
    void attemptSignup();
  }, [pathname, attemptSignup]);

  // Contextual asks: the first-team-invite and client code-join success
  // paths fire the trigger bus; presentation happens here, after the
  // success state, so those flows are never blocked or delayed.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    return onContextualPushAsk((trigger) => {
      if (trigger === 'realtor-signup') {
        pendingSignup.current = true;
        void attemptSignup();
        return;
      }
      const role: PushAskRole = trigger === 'realtor-invite' ? 'realtor' : 'client';
      void (async () => {
        try {
          const [state, permission] = await Promise.all([
            readPushAskState(role),
            getPushPermission(),
          ]);
          if (!contextualAskEligible(state, permission, trigger)) return;
          await new Promise((r) => setTimeout(r, SETTLE_MS));
          if (
            present({
              role,
              variant: trigger,
              permission,
              finalAsk: isFinalAsk(state),
              clientFirst: '',
            })
          ) {
            await recordContextualAskShown(role, trigger);
          }
        } catch {
          // a failed ask never reaches the success path
        }
      })();
    });
  }, [present]);

  const onNotNow = useCallback(() => {
    // "Not now" is the 14-day snooze: the ask was recorded at show
    // time, which is what starts the cooldown. Nothing else to write.
    setSheet(null);
  }, []);

  const onPrimary = useCallback(async () => {
    const current = sheet;
    setSheet(null);
    if (!current) return;
    try {
      if (current.permission === 'denied') {
        // The OS will never show the dialog again; the only path is
        // the device's Settings page for this app.
        await Linking.openSettings();
        return;
      }
      const granted = await requestPushPermission();
      if (granted) {
        if (current.role === 'realtor') await registerRealtorPushToken();
        else await registerPushToken();
      }
    } catch {
      // never block the surface under the sheet
    }
  }, [sheet]);

  const onDontAskAgain = useCallback(async () => {
    const current = sheet;
    setSheet(null);
    if (!current) return;
    await markDontAskAgain(current.role);
  }, [sheet]);

  if (!sheet) return null;

  // The sign-up/first-login sheet presents exactly as the timed
  // realtor sheet (standard copy, "Allow" primary, same testIDs).
  const timed = sheet.variant === 'timed' || sheet.variant === 'realtor-signup';
  const containerTestID = timed
    ? sheet.role === 'realtor'
      ? 'push-preprompt-realtor'
      : 'push-preprompt'
    : sheet.role === 'realtor'
      ? 'push-preprompt-realtor-ctx'
      : 'push-preprompt-client-ctx';
  const primaryTestID =
    (sheet.role === 'realtor' ? 'push-allow-realtor' : 'push-allow') + (timed ? '' : '-ctx');
  const notNowTestID =
    (sheet.role === 'realtor' ? 'push-notnow-realtor' : 'push-notnow') + (timed ? '' : '-ctx');

  let copy: string;
  if (sheet.variant === 'realtor-invite') {
    copy =
      'Your invite is on its way: turn on notifications so you know the moment your team joins and starts checking off steps.';
  } else if (sheet.variant === 'client-code-join') {
    copy = "You're in! Turn on notifications so you know the moment your realtor checks off a step.";
  } else if (sheet.role === 'realtor') {
    copy =
      'Get notified the moment a client joins an escrow, leaves a review, or submits an intake. Nothing important slips by.';
  } else {
    copy = sheet.clientFirst
      ? `Get notified the moment ${sheet.clientFirst} checks off a step. You will never have to keep checking.`
      : 'Get notified the moment your realtor checks off a step. You will never have to keep checking.';
  }

  const denied = sheet.permission === 'denied';
  const primaryTitle = denied ? 'Open Settings' : timed ? 'Allow' : 'Turn on notifications';

  return (
    <Sheet visible onClose={onNotNow}>
      <View style={styles.body} testID={containerTestID}>
        <Text style={styles.title}>Stay in the loop</Text>
        <Text style={denied ? styles.copyTight : styles.copy}>{copy}</Text>
        {denied ? (
          <Text style={styles.copy}>
            Notifications are turned off for Clear to Close in your device Settings.
          </Text>
        ) : null}
        <View testID={primaryTestID}>
          <PrimaryButton title={primaryTitle} onPress={onPrimary} />
        </View>
        <View style={styles.gap} />
        <View testID={notNowTestID}>
          <SecondaryButton title="Not now" onPress={onNotNow} />
        </View>
        {sheet.finalAsk ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Don't ask again"
            testID="push-dont-ask-again"
            onPress={onDontAskAgain}
            style={({ pressed }) => [styles.tertiary, pressed && { opacity: 0.6 }]}
          >
            <Text style={styles.tertiaryText}>Don&apos;t ask again</Text>
          </Pressable>
        ) : null}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: 4,
    paddingBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: 8,
  },
  copy: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
    marginBottom: 20,
  },
  copyTight: {
    fontSize: 15,
    lineHeight: 22,
    color: colors.body,
    marginBottom: 8,
  },
  gap: {
    height: 10,
  },
  tertiary: {
    alignItems: 'center',
    paddingVertical: 12,
    marginTop: 2,
  },
  tertiaryText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.muted,
  },
});
