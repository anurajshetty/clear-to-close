// Clear to Close — client home top card, built ONCE and reused by the buyer
// and seller home views.
//
// Faithful to APPROVED mockup 01 · device 4/5 (buyer/seller) + 11 (live
// update) + 14 (client home), reworked Sept 26:
//  - top row: bold "Hi {name}" headline, "Your purchase"/"Your sale" kicker,
//    non-bold address — with the realtor's photo circle top-right AT THE
//    GREETING LEVEL (48px tap target -> realtor profile).
//  - centered below: "N of N steps" above a bigger (84px) progress ring,
//    then the single days line — "days left: N" (label 14.5px, number
//    22px/800); "due today" at 0, red "overdue by N day(s)" past the target.
//  - when every step is checked, the banner slot shows "Congratulations,
//    your checklist is complete".
// Nothing else on the card is tappable. No JUST NOW markers anywhere.
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { Card, Kicker, initialsOf } from './ui';
import { ProgressRing } from './ProgressRing';
import { colors } from '../theme';
import type { RealtorProfile } from '../lib/types';

export type ClientTopCardProps = {
  greeting: string;
  kicker: string;
  address: string;
  city: string;
  daysToClose: number;
  done: number;
  total: number;
  profile: RealtorProfile | null;
  onProfilePress: () => void;
};

function DaysLine({ daysToClose }: { daysToClose: number }) {
  if (daysToClose === 0) {
    return (
      <Text style={[styles.byBig, styles.over]} testID="days-line">
        due today
      </Text>
    );
  }
  if (daysToClose < 0) {
    const n = Math.abs(daysToClose);
    return (
      <Text style={[styles.byBig, styles.over]} testID="days-line">
        overdue by <Text style={styles.overNum}>{n}</Text> {n === 1 ? 'day' : 'days'}
      </Text>
    );
  }
  return (
    <Text style={styles.byBig} testID="days-line">
      days left: <Text style={styles.byBigNum}>{daysToClose}</Text>
    </Text>
  );
}

export function ClientTopCard({
  greeting,
  kicker,
  address,
  city,
  daysToClose,
  done,
  total,
  profile,
  onProfilePress,
}: ClientTopCardProps) {
  const complete = total > 0 && done === total;
  return (
    <Card style={styles.hero} testID="client-topcard">
      <View style={styles.topRow}>
        <View style={styles.head}>
          <Text style={styles.greeting}>{greeting}</Text>
          <Kicker>{kicker}</Kicker>
          <Text style={styles.byaddr}>
            {address} · {city}
          </Text>
        </View>
        <Pressable
          onPress={onProfilePress}
          accessibilityRole="button"
          accessibilityLabel={`View your realtor ${profile?.name ?? ''}'s full profile`}
          style={styles.rav}
        >
          <View style={styles.rphotoHalo}>
            {profile?.photoUri ? (
              <Image source={{ uri: profile.photoUri }} style={styles.rphoto} />
            ) : (
              <View style={styles.rphoto}>
                <Text style={styles.rphotoInitials}>{initialsOf(profile?.name ?? '')}</Text>
              </View>
            )}
          </View>
        </Pressable>
      </View>
      <View style={styles.center}>
        <Text style={styles.ringCap}>{`${done} of ${total} steps`}</Text>
        <ProgressRing done={done} total={total} size={84} />
        <DaysLine daysToClose={daysToClose} />
      </View>
      {complete ? (
        <View style={styles.donePill} testID="completion-banner">
          <View style={styles.dot} />
          <Text style={styles.pillText}>Congratulations, your checklist is complete</Text>
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  hero: {
    marginTop: 14,
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  // Headline block + realtor photo side by side (mockup 01 · .by-toprow).
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  head: {
    flex: 1,
    minWidth: 0,
  },
  greeting: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.24,
    marginBottom: 6,
  },
  byaddr: {
    fontSize: 14.5,
    fontWeight: '400',
    color: colors.body,
    lineHeight: 21,
  },
  // Realtor photo entry point: 48px tap target at the greeting level.
  rav: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rphotoHalo: {
    // Soft accent halo outside the white ring (mockup 01 · .rav .rphoto).
    backgroundColor: colors.accentSoft,
    borderRadius: 29,
    padding: 2,
  },
  rphoto: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  rphotoInitials: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 17,
  },
  // Centered stack: steps count above the bigger ring, days line below it
  // (mockup 01 · .by-center).
  center: {
    alignItems: 'center',
    marginTop: 20,
  },
  ringCap: {
    fontSize: 11.5,
    fontWeight: '700',
    color: colors.body,
    marginBottom: 10,
  },
  // Single centered days line (mockup 01 · .by-big).
  byBig: {
    fontSize: 14.5,
    fontWeight: '600',
    color: colors.body,
    textAlign: 'center',
    marginTop: 10,
  },
  byBigNum: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.44,
  },
  over: {
    color: colors.red,
    fontWeight: '700',
  },
  overNum: {
    color: colors.red,
  },
  // Completion banner (mockup 01 · .updpill, device 11).
  donePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.accentSoft,
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
    flexShrink: 0,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
    lineHeight: 18.2,
    flexShrink: 1,
  },
});
