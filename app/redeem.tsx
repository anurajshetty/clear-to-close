// Clear to Close — client redeem (single form, Sept 2026).
//
// One screen: "Your name" + "Invite code" fields, one "Join your escrow"
// button. A branded invite link (/invite/<code>?name=<party>) pre-fills both
// fields (editable) and shows the realtor branding (photo, name, realty
// group, DRE, welcome) on the same form. The server validates the name
// authoritatively; the URL name is convenience only.
//
// Role label: TC invites show "Transaction Coordinator", buyer/seller show
// "client" (never distinguishes buyer from seller).
import React, { useEffect, useState } from 'react';
import {
  Image,
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
import type { ClientRole, InviteRealtor, RedeemResult } from '../src/lib/types';
import { realtorSubline } from '../src/lib/profile';
import { Field, Kicker, PrimaryButton, initialsOf } from '../src/components/ui';
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

/** "Transaction Coordinator" for TC, "client" for buyer/seller. */
function roleLabel(role: ClientRole): string {
  return role === 'tc' ? 'Transaction Coordinator' : 'client';
}

function Branding({ realtor }: { realtor: InviteRealtor }) {
  const [photoBroken, setPhotoBroken] = useState(false);
  const subline = realtorSubline({
    realty_group: realtor.realtyGroup,
    dreLicense: realtor.dreLicense,
  });
  const showPhoto = realtor.photoUrl && !photoBroken;
  return (
    <View style={styles.hero}>
      {showPhoto ? (
        <Image
          source={{ uri: realtor.photoUrl as string }}
          style={styles.photo}
          onError={() => setPhotoBroken(true)}
          accessibilityLabel={`${realtor.name}'s photo`}
        />
      ) : (
        <View style={[styles.photo, styles.photoFallback]}>
          <Text style={styles.photoInitials}>{initialsOf(realtor.name)}</Text>
        </View>
      )}
      <Text style={styles.name}>{realtor.name}</Text>
      {subline ? <Text style={styles.subline}>{subline}</Text> : null}
      <Text style={styles.roleLabel}>
        Invited as {roleLabel(realtor.role)}
      </Text>
      <Text style={styles.welcome}>
        You are invited to follow your escrow in Clear to Close. Enter your
        name and invite code below to join.
      </Text>
    </View>
  );
}

export default function Redeem() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string; code?: string }>();
  const prefillName = Array.isArray(params.name) ? params.name[0] : params.name;
  const prefillCode = Array.isArray(params.code) ? params.code[0] : params.code;

  const [code, setCode] = useState((prefillCode ?? '').trim().toUpperCase());
  const [name, setName] = useState(prefillName ?? '');
  const [realtor, setRealtor] = useState<InviteRealtor | null>(null);
  const [redeemError, setRedeemError] = useState<RedeemError | null>(null);
  const [linked, setLinked] = useState<{ escrowId: string; role: ClientRole; partyName: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // A code arriving via ?code= resolves the realtor branding for the form.
  // A resolve failure is not fatal: the form still works, and redeem
  // validates the code authoritatively.
  useEffect(() => {
    if (!prefillCode) return;
    let active = true;
    (async () => {
      const res = await store.resolveInviteRealtor(prefillCode);
      if (!active) return;
      if (res.ok) setRealtor(res.realtor);
    })();
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canRedeem = code.trim().length > 0 && name.trim().length > 0 && !busy;

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
      await auth.setClientLink({
        linkId: res.linkId,
        escrowId: res.escrowId,
        role: res.role,
        partyName: res.partyName,
        deviceId,
      });
      await auth.setRole('client');
      setLinked({ escrowId: res.escrowId, role: res.role, partyName: res.partyName });
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
          <RedeemCelebration
            escrowId={linked.escrowId}
            role={linked.role}
            clientName={linked.partyName}
            onViewEscrow={() => router.replace(`/client/${linked.role}/${linked.escrowId}`)}
            onStartOver={onStartOver}
          />
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Kicker>Client access</Kicker>
        <Text style={styles.h1}>Join your escrow</Text>

        {realtor ? <Branding realtor={realtor} /> : null}

        <View style={styles.form}>
          <Field
            label="Your name"
            value={name}
            onChangeText={(t) => { setName(t); setRedeemError(null); }}
            placeholder="e.g. Jordan Lee"
            autoCapitalize="words"
          />
          <Field
            label="Invite code"
            value={code}
            onChangeText={(t) => { setCode(t.toUpperCase()); setRedeemError(null); }}
            placeholder="6-character code"
            autoCapitalize="characters"
            autoCorrect={false}
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
  hero: { alignItems: 'center', marginTop: 24 },
  photo: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.accentSoft },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  photoInitials: { fontSize: 34, fontWeight: '800', color: colors.accent },
  name: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.24,
    marginTop: 14,
    textAlign: 'center',
  },
  subline: { fontSize: 14, color: colors.body, marginTop: 6, textAlign: 'center' },
  roleLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.accent,
    marginTop: 8,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  welcome: {
    fontSize: 15,
    color: colors.body,
    lineHeight: 23,
    textAlign: 'center',
    marginTop: 12,
    paddingHorizontal: 12,
  },
  form: { marginTop: 16 },
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
