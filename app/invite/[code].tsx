// Clear to Close — branded invite deep link (Sept 2026).
//
// /invite/<code>: a client opens the branded invite link their realtor
// shared. The code resolves the inviting realtor BEFORE name entry and the
// client sees the identical branded welcome as manual redeem. Continue goes
// to redeem with the code pre-filled; the code is never redeemed here.
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { store } from '../../src/lib/store-instance';
import { auth } from '../../src/lib/auth';
import type { InviteRealtor, ResolveInviteError } from '../../src/lib/types';
import { InviteWelcome } from '../../src/components/InviteWelcome';
import { Kicker, PrimaryButton } from '../../src/components/ui';
import { colors } from '../../src/theme';

const ERROR_COPY: Record<Exclude<ResolveInviteError, 'network' | 'unknown'>, string> = {
  invalid: "This code doesn't look right. Ask your realtor for a new invite link.",
  already_used: 'This invite was already used. Ask your realtor for a new invite link.',
  revoked: 'This invite is no longer active. Ask your realtor for a new invite link.',
};

export default function InviteDeepLink() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const rawCode = Array.isArray(params.code) ? params.code[0] : params.code;
  const code = (rawCode ?? '').trim().toUpperCase();
  const [realtor, setRealtor] = useState<InviteRealtor | null>(null);
  const [error, setError] = useState<ResolveInviteError | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!code) {
        if (active) setError('invalid');
        return;
      }
      const res = await store.resolveInviteRealtor(code);
      if (!active) return;
      if (res.ok) setRealtor(res.realtor);
      else setError(res.error);
    })();
    return () => {
      active = false;
    };
  }, [code]);

  const onStartOver = async () => {
    await auth.clearClientLink();
    await auth.clearRole();
    router.replace('/role');
  };

  if (error) {
    return (
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
          <Kicker>You’re invited</Kicker>
          <Text style={styles.h1}>This invite didn’t work</Text>
          <Text style={styles.sub}>
            {error === 'network'
              ? 'Something went wrong on our end. Check your connection and try again.'
              : error === 'unknown'
                ? 'Something went wrong on our end. Ask your realtor for a new invite link.'
                : ERROR_COPY[error]}
          </Text>
          <View style={styles.cta}>
            <PrimaryButton title="Start over" onPress={onStartOver} />
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (!realtor) {
    return (
      <SafeAreaView style={styles.screen}>
        <View style={styles.loading}>
          <ActivityIndicator size="large" color={colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <InviteWelcome
      realtor={realtor}
      onContinue={() => router.push(`/redeem?code=${encodeURIComponent(code)}`)}
      onStartOver={onStartOver}
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  h1: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.28,
    marginTop: 6,
  },
  sub: { fontSize: 15, color: colors.body, lineHeight: 23, marginTop: 8 },
  cta: { marginTop: 24 },
});
