// Clear to Close — "LATEST FROM {NAME}" card (client home).
//
// APPROVED mockup screen 7 (updated Sept 2026). Sits directly below the top
// card, above the checklist, in every state. Always visible: the single most
// recent realtor action — forward ("Checked off {step}", green check) and
// backward ("Reopened {step}", neutral icon, neutral wording, no blame) —
// or the "{Name} opened your escrow" fallback when no step has been checked
// off yet. Old timestamps render as calendar dates, never hidden.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Card } from './ui';
import { latestModel } from '../lib/latest';
import type { RealtorAction, StepT } from '../lib/types';
import { colors } from '../theme';

export function LatestFromCard({
  lastAction,
  steps,
  realtorName,
  openedAt,
  openDate,
}: {
  lastAction?: RealtorAction | null;
  steps: StepT[];
  realtorName: string;
  openedAt?: string | null;
  openDate?: string | null;
}) {
  const m = latestModel({ lastAction, steps, realtorName, openedAt, openDate });
  const reopened = m.icon === 'reopen';
  return (
    <Card style={styles.card} testID="latest-from-card">
      <Text style={styles.kicker} testID="latest-from-kicker">
        {m.kicker}
      </Text>
      <View style={styles.row}>
        <View
          style={[styles.icon, reopened ? styles.iconReopen : styles.iconCheck]}
          testID="latest-from-icon"
          accessibilityLabel={reopened ? 'Reopened step' : 'Checked-off step'}
        >
          <Text style={styles.iconGlyph}>{reopened ? '\u21BA' : '\u2713'}</Text>
        </View>
        <Text style={styles.body} testID="latest-from-body">
          {m.stepTitle ? (
            <>
              {m.lead} <Text style={styles.step}>{m.stepTitle}</Text>{' '}
              <Text style={styles.time}>· {m.time}</Text>
            </>
          ) : (
            <>
              {m.lead} <Text style={styles.time}>· {m.time}</Text>
            </>
          )}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  // Rhythm: the top card above carries an 18px bottom margin; this card
  // carries the same below it so the checklist breathes evenly.
  card: {
    marginBottom: 18,
  },
  kicker: {
    fontSize: 11,
    letterSpacing: 1.4,
    color: colors.muted,
    fontWeight: '700',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 8,
  },
  icon: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconCheck: {
    backgroundColor: colors.accent,
  },
  // Backward moves stay honest but blame-free: the same circle in the
  // neutral muted tone instead of the teal check.
  iconReopen: {
    backgroundColor: colors.muted,
  },
  iconGlyph: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  body: {
    fontSize: 14,
    color: colors.ink,
    flexShrink: 1,
  },
  step: {
    fontWeight: '700',
  },
  time: {
    color: colors.muted,
  },
});
