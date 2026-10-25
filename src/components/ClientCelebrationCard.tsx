// Clear to Close — client first-open celebration card (Oct 25, 2026
// packet, approved mockup frame 1).
//
// A one-time card at the top of the client escrow view: the first
// time a client opens their escrow after redeeming, they see 🎉 +
// "Congratulations, you're in escrow!" + "{realtor} has opened your
// escrow for {address}. Follow along here as each step gets checked
// off." The ✕ dismisses it during that visit; it never renders again
// for that client link + escrow.
//
// The seen-marker is DEVICE-LOCAL (auth service kv, keyed by link id
// + escrow id) — deliberately no server write: no client_links
// change, no notification rows, no drain involvement. The screens
// own the marker logic; this component is presentation only.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors } from '../theme';

export function ClientCelebrationCard({
  realtorName,
  address,
  onDismiss,
}: {
  realtorName: string;
  address: string;
  onDismiss: () => void;
}) {
  const name = realtorName.trim() || 'Your realtor';
  return (
    <View style={styles.card} testID="client-celebration">
      <Pressable
        onPress={onDismiss}
        hitSlop={10}
        style={styles.x}
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        testID="client-celebration-dismiss"
      >
        <Text style={styles.xText}>✕</Text>
      </Pressable>
      <Text style={styles.emoji}>🎉</Text>
      <Text style={styles.title}>Congratulations, you’re in escrow!</Text>
      <Text style={styles.body}>
        {name} has opened your escrow for <Text style={styles.strong}>{address}</Text>. Follow
        along here as each step gets checked off.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.amberSoft,
    borderWidth: 1,
    borderColor: colors.gold,
    borderRadius: 16,
    paddingTop: 18,
    paddingHorizontal: 16,
    paddingBottom: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  x: {
    position: 'absolute',
    top: 8,
    right: 12,
    padding: 2,
  },
  xText: {
    color: colors.muted,
    fontSize: 16,
  },
  emoji: {
    fontSize: 34,
    lineHeight: 38,
  },
  title: {
    fontSize: 19,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 6,
  },
  body: {
    fontSize: 13.5,
    color: colors.body,
    lineHeight: 20.9,
    textAlign: 'center',
  },
  strong: {
    color: colors.ink,
    fontWeight: '600',
  },
});
