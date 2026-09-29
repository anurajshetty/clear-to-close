// Clear to Close — shared multi-escrow chrome for the client escrow homes
// (Sept 28, 2026, Anuraj-approved mockup 01 · screens 11/4/5/14).
//
// <MyEscrowsBack/> — a "My escrows" back chevron above the top card. It
// renders ONLY when this device holds 2+ live links and navigates back to
// the escrow list. One-link devices keep their direct entry untouched.
// <JoinAnotherEscrow/> — a quiet muted text link at the bottom of the home
// (below the checklist, 44pt minimum target) that opens the redeem screen
// so a one-escrow client can add a second escrow. Built once, reused by
// buyer, seller, and TC homes.
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { auth } from '../lib/auth';
import { showEscrowListBack } from '../lib/escrowList';
import { colors, type } from '../theme';

export function MyEscrowsBack() {
  const router = useRouter();
  const [visible, setVisible] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      auth
        .getClientLinks()
        .then((links) => {
          if (active) setVisible(showEscrowListBack(links.length));
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );
  if (!visible) return null;
  return (
    <Pressable
      style={styles.back}
      onPress={() => router.replace('/client/escrows')}
      accessibilityRole="button"
      accessibilityLabel="Back to my escrows"
    >
      <Text style={styles.backChevron}>‹</Text>
      <Text style={styles.backText}>My escrows</Text>
    </Pressable>
  );
}

export function JoinAnotherEscrow() {
  const router = useRouter();
  return (
    <Pressable
      style={styles.join}
      onPress={() => router.push('/redeem')}
      accessibilityRole="button"
      accessibilityLabel="Join another escrow"
    >
      <Text style={styles.joinText}>Join another escrow</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    minHeight: 44,
    paddingRight: 12,
    marginBottom: 4,
  },
  backChevron: { color: colors.accent, fontSize: 26, fontWeight: '600', marginTop: -2 },
  backText: { color: colors.accent, fontSize: type.step, fontWeight: '600' },
  // Quiet footer link (approved): muted, centered, 44pt minimum.
  join: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    marginTop: 18,
  },
  joinText: { color: colors.muted, fontSize: type.body, fontWeight: '600' },
});
