// Clear to Close — root layout + launch router (approved onboarding/auth).
//
// Boot order:
//   1. Read the remembered role, the persisted session (both platforms —
//      web keeps it in localStorage, native in AsyncStorage), and the
//      device client link.
//   2. Resolve the launch destination (role picker → signup/redeem steps →
//      deal list / client escrow), replacing the route so onboarding can't
//      be backed out of.
//   3. Client links are validated before the escrow renders: a dead link
//      (regenerated/revoked) lands on /link-dead, never a half-loaded view.
//   4. initCloudSync runs in the background (never blocks UI, never throws);
//      sync stays dormant until a realtor session exists.
// A Supabase auth listener watches for mid-session expiry on the web:
// unexpected sign-outs send the realtor to /login?expired=1 with the
// approved copy. Our own sign-out navigates to /role directly.
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { Stack, usePathname, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { auth, parseRecoveryLink, takeExpectSignOut } from '../src/lib/auth';
import { resolveBootHref, resolvePostAuthHref } from '../src/lib/bootRoute';
import { initCloudSync, store } from '../src/lib/store-instance';
import { unregisterPushTokenForLink } from '../src/lib/push';
import { PushGate } from '../src/components/PushGate';
import { SyncErrorBar } from '../src/components/SyncErrorBar';
import { colors } from '../src/theme';

/**
 * Password-reset recovery is WEB ONLY (Sept 2026): the reset email opens
 * in the browser by design; the user sets the new password there and then
 * signs into the iPhone app with it. No deep-link plumbing.
 */

/**
 * Drop the recovery fragment from the web URL after it has been consumed,
 * so a refresh can't re-trigger the recovery flow.
 */
function clearRecoveryFragment(): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  try {
    window.history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search,
    );
  } catch {
    // ignore
  }
}

export default function RootLayout() {
  const router = useRouter();
  const pathname = usePathname();
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        // Password-reset recovery (Sept 2026, WEB ONLY): a recovery link
        // lands with the Supabase recovery payload in the URL fragment.
        // Parse it on app start, establish the recovery session, and route
        // to the "Set new password" screen. Expired/invalid links get the
        // fresh-link path instead of a dead end.
        const launchUrl =
          Platform.OS === 'web' && typeof window !== 'undefined'
            ? window.location.href
            : null;
        const recovery = parseRecoveryLink(launchUrl ?? '');
        if (recovery.kind === 'recovery') {
          clearRecoveryFragment();
          const consumed = await auth.consumeRecoverySession(
            recovery.accessToken,
            recovery.refreshToken,
          );
          if (consumed.ok) {
            await auth.setRole('realtor');
            await auth.setHasAccount(true);
            if (active) router.replace('/reset-password' as never);
          } else {
            if (active) router.replace('/reset-password?expired=1' as never);
          }
          return;
        }
        if (recovery.kind === 'recovery-error') {
          clearRecoveryFragment();
          if (active) router.replace('/reset-password?expired=1' as never);
          return;
        }
        // The public realtor profile (/realtor/<id>, Sept 2026) opens for
        // anyone with no login: never redirect away from it on boot. Same
        // for the branded invite deep link (/invite/<code>) and the in-app
        // realtor profile opened from the redeem celebration
        // (/realtor-profile, Sept 2026).
        if (
          pathname.startsWith('/realtor/') ||
          pathname.startsWith('/invite/') ||
          pathname === '/realtor-profile'
        )
          return;
        const isWeb = auth.isWeb();
        const [role, clientLinks, hasAccount] = await Promise.all([
          auth.getRole(),
          auth.getClientLinks(),
          auth.getHasAccount(),
        ]);
        // The realtor session persists on both platforms (web: localStorage,
        // native: AsyncStorage): a refresh keeps the realtor signed in, on
        // the same screen. The session ends on Log out, or when the
        // browser/incognito session ends.
        const sessionUserId = await auth.getSessionUserId();
        // Multi-escrow: validate every link. Invalid links are dropped
        // individually — a dead escrow never kills the device's other
        // escrows. Offline validation failure fails open (the screen
        // re-checks on focus).
        const liveLinks = [];
        for (const link of clientLinks) {
          try {
            const v = await store.validateClientLink(link.linkId);
            if (v.valid) liveLinks.push(link);
            else {
              await auth.removeClientLink(link.linkId);
              try {
                await unregisterPushTokenForLink(link.linkId);
              } catch {
                // best-effort
              }
            }
          } catch {
            liveLinks.push(link);
          }
        }
        let href = resolveBootHref({ role, sessionUserId, clientLinks: liveLinks, hasAccount, isWeb });
        if (href === '/' && sessionUserId) {
          // Mid-onboarding resume: an account with no profile (and no skip)
          // resumes at profile creation (step 2), not the deal list. The
          // profile is pulled from the cloud when the local store is missing
          // it, so an existing account never lands on profile creation.
          try {
            const [profile, skipped] = await Promise.all([
              store.pullProfileFromCloud(),
              auth.getProfileSkipped(),
            ]);
            href = resolvePostAuthHref({ sessionUserId, profile, skipped });
            // A realtor resuming on a device whose local KV was never seeded
            // must see their existing escrows: hydrate the deal list from
            // the cloud before it renders (never throws; falls back local).
            await store.pullEscrowsFromCloud();
          } catch {
            // Profile read failure: fall through to the deal list.
          }
        }
        // Every client href above was built from links already validated
        // per-link in this boot pass; the screens re-check on focus.
        if (active) router.replace(href as never);
      } catch {
        if (active) router.replace('/role' as never);
      } finally {
        if (active) setBooted(true);
      }
      // Sync activates under the realtor's email/password identity once a
      // session exists; otherwise it stays dormant (local-only v1).
      void initCloudSync().catch(() => {});
    })();
    return () => {
      active = false;
    };
  }, [router]);

  useEffect(() => {
    // Mid-session expiry (web): an unexpected SIGNED_OUT returns the realtor
    // to login with the approved "session expired" copy. Our own sign-out
    // sets the expectation flag and navigates to /role itself.
    const off = auth.onAuthStateChange((event) => {
      if (event !== 'SIGNED_OUT') return;
      if (takeExpectSignOut()) return;
      void auth.getRole().then((role) => {
        if (role === 'realtor') router.replace('/login?expired=1' as never);
      });
    });
    return () => {
      if (off) off();
    };
  }, [router]);

  if (!booted) {
    return (
      <View style={styles.boot}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  return (
    <>
      <StatusBar style="dark" />
      {/* Sync failures are never silent: a persistent bar shows every
          write that did not reach the server (realtor only). */}
      <SyncErrorBar />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="role" />
        <Stack.Screen name="signup" />
        <Stack.Screen name="login" />
        <Stack.Screen name="reset-password" />
        <Stack.Screen name="profile-create" />
        <Stack.Screen name="profile-update" />
        <Stack.Screen name="link-dead" />
        <Stack.Screen name="escrow/[id]" />
        <Stack.Screen name="share/[id]" />
        <Stack.Screen name="redeem" />
        <Stack.Screen name="profile-setup" />
        <Stack.Screen name="client/buyer/[id]" />
        <Stack.Screen name="client/seller/[id]" />
        <Stack.Screen name="client/profile" />
        <Stack.Screen name="realtor/[id]" />
        <Stack.Screen name="invite/[code]" />
      </Stack>
      {/* Client push: permission pre-prompt, token refresh, tap routing. */}
      <PushGate />
    </>
  );
}

const styles = StyleSheet.create({
  boot: {
    flex: 1,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
