// Clear to Close — dead client link (approved onboarding/auth ㉓,
// multi-escrow Sept 28, 2026).
// Shown when this escrow's device client link no longer validates (the
// realtor regenerated the code and the old link was killed, or the invite
// was revoked). Never a blank or half-loaded escrow: an explicit state with
// the two recovery paths. "Enter the new code" re-opens the redeem form with
// the name pre-filled (the name arrives as a param, because the dead link
// itself is already gone).
//
// Multi-escrow: only this escrow's link died — the device's other escrows'
// links stay valid. "Start over" becomes "Back to my escrows" when other
// valid links remain, so the client never loses their other escrows from
// here.
import React, { useEffect, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { auth } from '../src/lib/auth';
import { PrimaryButton, TextLink } from '../src/components/ui';
import { colors } from '../src/theme';

export default function LinkDead() {
  const router = useRouter();
  const params = useLocalSearchParams<{ name?: string }>();
  const [busy, setBusy] = useState(false);
  const [hasOtherLinks, setHasOtherLinks] = useState(false);

  useEffect(() => {
    let active = true;
    auth
      .getClientLinks()
      .then((links) => {
        if (active) setHasOtherLinks(links.length > 0);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const prefillName = Array.isArray(params.name) ? params.name[0] : params.name;

  const onEnterNewCode = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const redeemParams = prefillName ? { name: prefillName } : undefined;
      router.push({ pathname: '/redeem', params: redeemParams });
    } finally {
      setBusy(false);
    }
  };

  const onStartOver = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (hasOtherLinks) {
        // Multi-escrow: other escrows still live on this device — go back
        // to the list, never wipe them.
        router.replace('/client/escrows');
        return;
      }
      await auth.clearClientLink();
      await auth.clearRole();
      router.replace('/role');
    } finally {
      setBusy(false);
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
        <TextLink
          title={hasOtherLinks ? 'Back to my escrows' : 'Not your escrow? Start over'}
          onPress={onStartOver}
        />
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
