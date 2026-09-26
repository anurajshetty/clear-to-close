// Clear to Close — dead client link (approved onboarding/auth ㉓).
// Shown when the stored device client link no longer validates (the realtor
// regenerated the code and the old link was killed, or the invite was
// revoked). Never a blank or half-loaded escrow: an explicit state with the
// two recovery paths. "Enter the new code" re-opens the redeem form with the
// name pre-filled.
import React, { useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { auth } from '../src/lib/auth';
import { PrimaryButton, TextLink } from '../src/components/ui';
import { colors } from '../src/theme';

export default function LinkDead() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onEnterNewCode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const link = await auth.getClientLink();
      const params = link?.partyName
        ? { name: link.partyName }
        : undefined;
      router.push({ pathname: '/redeem', params });
    } finally {
      setBusy(false);
    }
  };

  const onStartOver = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await auth.clearClientLink();
      await auth.clearRole();
    } finally {
      router.replace('/role');
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.iconWrap}>
          <View style={styles.iconBar} />
          <View style={styles.iconDot} />
        </View>
        <Text style={styles.h1}>This code no longer works</Text>
        <Text style={styles.sub}>
          Your realtor created a new code for this escrow. The old one and its
          device link were replaced. Ask your realtor for the new code.
        </Text>
        <View style={styles.cta}>
          <PrimaryButton title="Enter the new code" onPress={onEnterNewCode} />
        </View>
        <TextLink title="Not your escrow? Start over" onPress={onStartOver} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: {
    paddingHorizontal: 20,
    paddingTop: 64,
    paddingBottom: 40,
    alignItems: 'center',
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.amberSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconBar: {
    width: 4.5,
    height: 26,
    borderRadius: 2.25,
    backgroundColor: colors.amber,
    marginTop: 6,
  },
  iconDot: {
    width: 4.5,
    height: 4.5,
    borderRadius: 2.25,
    backgroundColor: colors.amber,
    marginTop: 5,
  },
  h1: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.24,
    marginTop: 18,
    textAlign: 'center',
  },
  sub: {
    fontSize: 14.5,
    color: colors.body,
    lineHeight: 23,
    marginTop: 8,
    textAlign: 'center',
    maxWidth: 320,
  },
  cta: { marginTop: 28, alignSelf: 'stretch' },
});
