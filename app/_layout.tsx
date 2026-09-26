// Clear to Close — root layout + launch router (approved onboarding/auth).
//
// Boot order:
//   1. Read the remembered role, the persisted session (native only — web
//      never restores a session), and the device client link.
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
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { auth, takeExpectSignOut } from '../src/lib/auth';
import { resolveBootHref, resolvePostAuthHref } from '../src/lib/bootRoute';
import { initCloudSync, store } from '../src/lib/store-instance';
import { colors } from '../src/theme';

export default function RootLayout() {
  const router = useRouter();
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const isWeb = auth.isWeb();
        const [role, clientLink, hasAccount] = await Promise.all([
          auth.getRole(),
          auth.getClientLink(),
          auth.getHasAccount(),
        ]);
        // Web never restores the realtor session (memory-only auth storage):
        // returning web realtors sign in every visit.
        const sessionUserId = isWeb ? null : await auth.getSessionUserId();
        let href = resolveBootHref({ role, sessionUserId, clientLink, hasAccount, isWeb });
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
        if (href.startsWith('/client/') && clientLink) {
          // Validate the stored link before rendering the escrow.
          try {
            const v = await store.validateClientLink(clientLink.linkId);
            if (!v.valid) href = '/link-dead';
          } catch {
            // Validation failure fails open: render; the screen re-checks.
          }
        }
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
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="role" />
        <Stack.Screen name="signup" />
        <Stack.Screen name="login" />
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
      </Stack>
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
