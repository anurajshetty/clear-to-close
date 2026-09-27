// Clear to Close — client redeem (approved onboarding/auth ⑲).
//
// Stepped flow (Sept 2026): the invite code validates FIRST, then the client
// sees the identical branded welcome as the invite deep link (/invite/<code>)
// BEFORE name entry. A successful redeem binds this device's id to the
// client link; reopening goes straight to the escrow. Every failure gets its
// specific error + next step, never a dead end.
import React, { useEffect, useState } from 'react';
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
import type { ClientRole, InviteRealtor, RedeemResult, ResolveInviteError } from '../src/lib/types';
import { InviteWelcome } from '../src/components/InviteWelcome';
import { BackChevron, Field, Kicker, PrimaryButton, TextLink } from '../src/components/ui';
import { RedeemCelebration } from '../src/components/RedeemCelebration';
import { colors } from '../src/theme';

type RedeemError = Exclude<RedeemResult, { ok: true }>['error'];

const ERROR_COPY: Record<RedeemError, string> = {
  invalid: "This code doesn't look right. Check it and try again.",
  already_used: 'This code was already used. Ask your realtor for a new code.',
  revoked: 'This code is no longer active. Ask your realtor for the new code.',
  name_mismatch: "That name doesn't match this invite. Check the spelling and try again.",
  network: 'Something went wrong on our end. Check your connection and try again.',
  device_has_link:
    'This device is already linked to another escrow. Ask your realtor to release it, then try again.',
};

const RESOLVE_COPY: Record<ResolveInviteError, string> = {
  invalid: ERROR_COPY.invalid,
  already_used: ERROR_COPY.already_used,
  revoked: ERROR_COPY.revoked,
  unknown: 'Something went wrong on our end. Check your connection and try again.',
  network: 'Something went wrong on our end. Check your connection and try again.',
};

type Step = 'code' | 'welcome' | 'name';

export default function Redeem() {
  const router = useRouter();
  // The dead-link recovery flow (㉓) re-opens redeem with the name pre-filled.
  // The branded invite deep link (/invite/<code>) lands here with the code
  // pre-filled and already validated — it skips straight to the welcome.
  const params = useLocalSearchParams<{ name?: string; code?: string }>();
  const prefillName = Array.isArray(params.name) ? params.name[0] : params.name;
  const prefillCode = Array.isArray(params.code) ? params.code[0] : params.code;

  const [step, setStep] = useState<Step>(prefillCode ? 'welcome' : 'code');
  const [code, setCode] = useState((prefillCode ?? '').trim().toUpperCase());
  const [name, setName] = useState(prefillName ?? '');
  const [realtor, setRealtor] = useState<InviteRealtor | null>(null);
  const [resolveError, setResolveError] = useState<ResolveInviteError | null>(null);
  const [redeemError, setRedeemError] = useState<RedeemError | null>(null);
  const [resolving, setResolving] = useState(!!prefillCode);
  // TC invites (role 'tc') redeem through the same stepped flow; a redeemed
  // TC invite routes to /client/tc/<escrowId> via the role in the URL below.
  const [linked, setLinked] = useState<{ escrowId: string; role: ClientRole } | null>(null);
  const [busy, setBusy] = useState(false);

  // A code arriving via ?code= still resolves the realtor (never trusted
  // blind): the welcome screen always shows the resolved identity.
  useEffect(() => {
    if (!prefillCode) return;
    let active = true;
    (async () => {
      setResolving(true);
      const res = await store.resolveInviteRealtor(prefillCode);
      if (!active) return;
      if (res.ok) {
        setRealtor(res.realtor);
        setStep('welcome');
      } else {
        setResolveError(res.error);
        setStep('code');
      }
      setResolving(false);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canCheckCode = code.trim().length > 0 && !resolving;

  const onCheckCode = async () => {
    if (!canCheckCode) return;
    setResolving(true);
    setResolveError(null);
    try {
      const res = await store.resolveInviteRealtor(code);
      if (!res.ok) {
        setResolveError(res.error);
        return;
      }
      setRealtor(res.realtor);
      setStep('welcome');
    } finally {
      setResolving(false);
    }
  };

  const canRedeem = name.trim().length > 0 && !busy;

  const onRedeem = async () => {
    if (!canRedeem) return;
    setBusy(true);
    setRedeemError(null);
    try {
      const deviceId = await auth.getDeviceId();
      const res = await store.redeemInvite(code, name, deviceId);
      if (!res.ok) {
        setRedeemError(res.error);
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
          {/* A redeemed TC invite routes to /client/tc/<escrowId> through the
              role in the URL — that screen shows both checklists on a
              both-side escrow (Anuraj's decision). */}
          <RedeemCelebration
            escrowId={linked.escrowId}
            role={linked.role}
            onViewEscrow={() => router.replace(`/client/${linked.role}/${linked.escrowId}`)}
            onStartOver={onStartOver}
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (step === 'welcome' && realtor) {
    return (
      <InviteWelcome
        realtor={realtor}
        continueTitle="Continue"
        onContinue={() => setStep('name')}
        onStartOver={onStartOver}
      />
    );
  }

  if (step === 'name') {
    return (
      <SafeAreaView style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <BackChevron label="Code" onPress={() => setStep('code')} />
          <Kicker>Client access</Kicker>
          <Text style={styles.h1}>Almost there</Text>
          <Text style={styles.sub}>
            Enter the name your realtor used for this invite. It has to match.
          </Text>

          <View style={styles.form}>
            <Field
              label="Your name"
              value={name}
              onChangeText={(t) => { setName(t); setRedeemError(null); }}
              placeholder="e.g. Jordan Lee"
              autoCapitalize="words"
            />
            {redeemError ? <Text style={styles.inlineError}>{ERROR_COPY[redeemError]}</Text> : null}
          </View>

          <View style={styles.cta}>
            <PrimaryButton
              title={busy ? 'Joining…' : 'Join your escrow'}
              onPress={onRedeem}
              disabled={!canRedeem}
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

  // step === 'code'
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BackChevron label="Role" onPress={() => router.push('/role')} />
        <Kicker>Client access</Kicker>
        <Text style={styles.h1}>Join your escrow</Text>
        <Text style={styles.sub}>
          Enter the invite code your realtor shared with you.
        </Text>

        <View style={styles.form}>
          <Field
            label="Invite code"
            value={code}
            onChangeText={(t) => { setCode(t.toUpperCase()); setResolveError(null); }}
            placeholder="6-character code"
            autoCapitalize="characters"
            autoCorrect={false}
          />
          {resolveError ? <Text style={styles.inlineError}>{RESOLVE_COPY[resolveError]}</Text> : null}
        </View>

        <View style={styles.cta}>
          <PrimaryButton
            title={resolving ? 'Checking…' : 'Continue'}
            onPress={onCheckCode}
            disabled={!canCheckCode}
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
