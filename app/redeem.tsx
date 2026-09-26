// Clear to Close — client redeem (approved onboarding/auth ⑲).
// Name + six-character code, both verified. A successful redeem binds this
// device's id to the client link; reopening goes straight to the escrow.
// Every failure gets its specific error + next step, never a dead end.
import React, { useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { auth } from '../src/lib/auth';
import { store } from '../src/lib/store-instance';
import type { RedeemResult } from '../src/lib/types';
import { BackChevron, Field, Kicker, PrimaryButton, TextLink } from '../src/components/ui';
import { colors } from '../src/theme';

type RedeemError = Exclude<RedeemResult, { ok: true }>['error'];

const ERROR_COPY: Record<RedeemError, string> = {
  invalid: "This code doesn't look right — check it and try again.",
  already_used: 'This code was already used — ask your realtor for a new code.',
  revoked: 'This code is no longer active — ask your realtor for the new code.',
  name_mismatch: "That name doesn't match this invite — check the spelling and try again.",
  network: 'Something went wrong on our end — check your connection and try again.',
  device_has_link:
    'This device is already linked to another escrow — ask your realtor to release it, then try again.',
};

export default function Redeem() {
  const router = useRouter();
  // The dead-link recovery flow (㉓) re-opens redeem with the name pre-filled.
  const params = useLocalSearchParams<{ name?: string }>();
  const prefill = Array.isArray(params.name) ? params.name[0] : params.name;
  const [name, setName] = useState(prefill ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState<RedeemError | null>(null);
  const [linked, setLinked] = useState<{ escrowId: string; role: 'buyer' | 'seller' } | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = name.trim().length > 0 && code.trim().length > 0 && !busy;

  const onRedeem = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const deviceId = await auth.getDeviceId();
      const res = await store.redeemInvite(code, name, deviceId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Bind this device: persist the client link (the access key), remember
      // the client role, and go straight to the escrow.
      await auth.setClientLink({
        linkId: res.linkId,
        escrowId: res.escrowId,
        role: res.role,
        partyName: res.partyName,
        deviceId,
      });
      await auth.setRole('client');
      setLinked({ escrowId: res.escrowId, role: res.role });
    } finally {
      setBusy(false);
    }
  };

  const onStartOver = async () => {
    await auth.clearClientLink();
    await auth.clearRole();
    router.replace('/role');
  };

  if (linked) {
    return (
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content}>
          <Kicker>Client access</Kicker>
          <Text style={styles.h1}>You&apos;re linked up</Text>
          <Text style={styles.sub}>This device is now linked to your escrow</Text>
          <View style={styles.cta}>
            <PrimaryButton
              title="View my escrow"
              onPress={() => router.replace(`/client/${linked.role}/${linked.escrowId}`)}
            />
          </View>
          <TextLink title="Not your escrow? Start over" onPress={onStartOver} />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BackChevron label="Role" onPress={() => router.push('/role')} />
        <Kicker>Client access</Kicker>
        <Text style={styles.h1}>Join your escrow</Text>
        <Text style={styles.sub}>
          Enter the name and invite code your realtor shared with you.
        </Text>

        <View style={styles.form}>
          <Field
            label="Your name"
            value={name}
            onChangeText={(t) => { setName(t); setError(null); }}
            placeholder="e.g. Jordan Lee"
            autoCapitalize="words"
          />
          <Field
            label="Invite code"
            value={code}
            onChangeText={(t) => { setCode(t); setError(null); }}
            placeholder="6-character code"
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {error ? <Text style={styles.inlineError}>{ERROR_COPY[error]}</Text> : null}
        </View>

        <View style={styles.cta}>
          <PrimaryButton
            title={busy ? 'Checking…' : 'Continue'}
            onPress={onRedeem}
            disabled={!canSubmit}
          />
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={onStartOver}
          style={styles.startOver}
        >
          <Text style={styles.startOverText}>Not your escrow? </Text>
          <Text style={styles.link}>Start over</Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  h1: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.28,
    marginTop: 6,
  },
  sub: { fontSize: 15, color: colors.body, lineHeight: 23, marginTop: 8 },
  form: { marginTop: 8 },
  inlineError: { fontSize: 13, fontWeight: '600', color: colors.red, marginTop: 8 },
  cta: { marginTop: 24 },
  startOver: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
    paddingVertical: 8,
  },
  startOverText: { fontSize: 15, color: colors.body },
  link: { fontSize: 15, fontWeight: '700', color: colors.accent },
});
