// Clear to Close — branded invite welcome (Sept 2026).
//
// The identical branded screen shown (a) when a client opens a branded invite
// deep link (/invite/<code>), and (b) on manual redeem after the code
// validates, before name entry. Realtor by name only: photo with initials
// fallback, name headline, realty group / DRE subline via realtorSubline
// (never a dangling separator). No gendered pronouns, no em dashes.
import React, { useState } from 'react';
import { Image, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { InviteRealtor } from '../lib/types';
import { realtorSubline } from '../lib/profile';
import { Kicker, PrimaryButton, TextLink, initialsOf } from './ui';
import { colors } from '../theme';

export function InviteWelcome({
  realtor,
  continueTitle = 'Continue',
  onContinue,
  onStartOver,
}: {
  realtor: InviteRealtor;
  continueTitle?: string;
  onContinue: () => void;
  onStartOver: () => void;
}) {
  const [photoBroken, setPhotoBroken] = useState(false);
  const subline = realtorSubline({
    realty_group: realtor.realtyGroup,
    dreLicense: realtor.dreLicense,
  });
  const showPhoto = realtor.photoUrl && !photoBroken;

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Kicker>You’re invited</Kicker>
        <View style={styles.hero}>
          {showPhoto ? (
            <Image
              source={{ uri: realtor.photoUrl as string }}
              style={styles.photo}
              onError={() => setPhotoBroken(true)}
              accessibilityLabel={`${realtor.name}’s photo`}
            />
          ) : (
            <View style={[styles.photo, styles.photoFallback]}>
              <Text style={styles.photoInitials}>{initialsOf(realtor.name)}</Text>
            </View>
          )}
          <Text style={styles.name}>{realtor.name}</Text>
          {subline ? <Text style={styles.subline}>{subline}</Text> : null}
        </View>
        <Text style={styles.body}>
          Your realtor invited you to follow your escrow in Clear to Close. You
          will see every step as it is checked off.
        </Text>
        <View style={styles.cta}>
          <PrimaryButton title={continueTitle} onPress={onContinue} />
        </View>
        <TextLink title="Not your escrow? Start over" onPress={onStartOver} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  hero: { alignItems: 'center', marginTop: 28 },
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
  body: {
    fontSize: 15,
    color: colors.body,
    lineHeight: 23,
    textAlign: 'center',
    marginTop: 18,
    paddingHorizontal: 12,
  },
  cta: { marginTop: 28 },
});
