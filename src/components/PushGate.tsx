// Clear to Close — PushGate: client-side push bootstrap + permission pre-prompt.
//
// Mounted once in app/_layout.tsx after boot. Web is a safe no-op (every
// helper in src/lib/push.ts guards Platform.OS === 'web').
//
// Ask-once (Anuraj's rule): the pre-prompt appears at most once per device
// (ctc:pushasked). "Not now" and a denied OS answer both count as asked;
// the prompt never nags again. While permission is granted, the token is
// re-registered on every launch so reinstalls/rotations self-heal.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { auth } from '../lib/auth';
import {
  getPushPermission,
  hasBeenAskedPush,
  loadNotifications,
  markPushAsked,
  registerPushToken,
  requestPushPermission,
  setupPushHandling,
  shouldShowPrePrompt,
} from '../lib/push';
import { store } from '../lib/store-instance';
import { PrimaryButton, SecondaryButton, Sheet } from './ui';
import { colors } from '../theme';

const CLIENT_HOME_RE = /^\/client\/(buyer|seller)\/[^/]+$/;

export function PushGate(): React.ReactElement | null {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const [visible, setVisible] = useState(false);
  const [realtorFirst, setRealtorFirst] = useState('');
  const evaluated = useRef(false);

  const routeToEscrow = useCallback(
    (escrowId: string, role: string) => {
      const r = role === 'seller' ? 'seller' : 'buyer';
      router.replace(`/client/${r}/${escrowId}` as never);
    },
    [router],
  );

  // One-time native bootstrap: foreground suppression + tap routing
  // (warm + cold start), and token refresh while granted.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!loadNotifications()) return;
    const cleanup = setupPushHandling(routeToEscrow);
    void auth
      .getClientLinks()
      .then((links) => {
        if (links.length > 0) return registerPushToken();
        return false;
      })
      .catch(() => false);
    return cleanup;
  }, [routeToEscrow]);

  // Pre-prompt eligibility: client on their escrow home, never asked,
  // OS permission still undetermined.
  useEffect(() => {
    if (evaluated.current) return;
    if (Platform.OS === 'web') return;
    if (!CLIENT_HOME_RE.test(pathname)) return;
    evaluated.current = true;
    let active = true;
    (async () => {
      try {
        const [role, links, asked, permission] = await Promise.all([
          auth.getRole(),
          auth.getClientLinks(),
          hasBeenAskedPush(),
          getPushPermission(),
        ]);
        if (
          !shouldShowPrePrompt({ role, hasLink: links.length > 0, asked, permission })
        ) {
          return;
        }
        const profile = await store.getClientProfile(links[0]?.escrowId ?? null).catch(() => null);
        const first = (profile?.name ?? '').trim().split(/\s+/)[0] ?? '';
        // Small settle delay so the home/celebration lands first.
        await new Promise((r) => setTimeout(r, 1200));
        if (!active) return;
        if (first) setRealtorFirst(first);
        setVisible(true);
      } catch {
        // never block the client home
      }
    })();
    return () => {
      active = false;
    };
  }, [pathname]);

  const dismiss = useCallback(async () => {
    await markPushAsked();
    setVisible(false);
  }, []);

  const onNotNow = useCallback(() => {
    void dismiss();
  }, [dismiss]);

  const onAllow = useCallback(async () => {
    try {
      const granted = await requestPushPermission();
      await markPushAsked();
      if (granted) await registerPushToken();
    } catch {
      // never block the client home
    } finally {
      setVisible(false);
    }
  }, []);

  if (!visible) return null;

  const copy = realtorFirst
    ? `Get notified the moment ${realtorFirst} checks off a step. You will never have to keep checking.`
    : 'Get notified the moment your realtor checks off a step. You will never have to keep checking.';

  return (
    <Sheet visible={visible} onClose={onNotNow}>
      <View style={styles.body} testID="push-preprompt">
        <Text style={styles.title}>Stay in the loop</Text>
        <Text style={styles.copy}>{copy}</Text>
        <View testID="push-allow">
          <PrimaryButton title="Allow" onPress={onAllow} />
        </View>
        <View style={styles.gap} />
        <View testID="push-notnow">
          <SecondaryButton title="Not now" onPress={onNotNow} />
        </View>
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
  gap: {
    height: 10,
  },
});
