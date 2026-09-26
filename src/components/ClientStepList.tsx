// Clear to Close — shared read-only client checklist.
//
// Used by BOTH the buyer view and the seller view (single-side and both-side
// escrows): build once, never duplicate. Mirrors the realtor's stepper via the
// shared StepRow with interactive={false} — same check circles, connecting
// rail, subtitles, and UP NEXT tag — with zero tap targets, zero drag grips,
// and no Custom tag on custom steps.
//
// Completed renders on top, most-recently-completed first; Remaining below in
// checklist order. "Just now" tags and the update notice are computed from
// step.completedAt at render time and expire after RECENCY_WINDOW_HOURS; the
// step itself stays in Completed after expiry.
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Card } from './ui';
import { StepRow } from './StepRow';
import type { StepT } from '../lib/types';
import { isRecent } from '../lib/recency';
import {
  mostRecentCheckoff,
  sortCompletedFirst,
  sortRemainingSteps,
} from '../lib/clientView';
import { colors } from '../theme';

/**
 * "Your realtor checked off X just now." pill. Shown only while the most
 * recent checkoff is inside the recency window; renders nothing after expiry.
 */
export function RecentUpdatePill({ steps }: { steps: StepT[] }) {
  const recent = mostRecentCheckoff(steps);
  if (!recent) return null;
  return (
    <View style={styles.pill}>
      <View style={styles.dot} />
      <Text style={styles.pillText}>
        Your realtor checked off “{recent.title}” just now.
      </Text>
    </View>
  );
}

export function ClientStepList({ steps }: { steps: StepT[] }) {
  // Computed once at render from the device clock — no live ticking.
  const now = Date.now();
  const completed = sortCompletedFirst(steps);
  const remaining = sortRemainingSteps(steps);

  return (
    <View>
      <Text style={styles.section}>Completed</Text>
      {completed.length > 0 ? (
        <Card style={styles.listCard}>
          <View style={styles.list}>
            <View style={styles.rail} />
            {completed.map((s) => (
              <StepRow
                key={s.id}
                title={s.title}
                subtitle={s.subtitle}
                done
                interactive={false}
                recent={isRecent(s.completedAt, now)}
              />
            ))}
          </View>
        </Card>
      ) : (
        <Text style={styles.empty}>Nothing completed yet.</Text>
      )}

      {remaining.length > 0 && (
        <>
          <Text style={styles.section}>Remaining</Text>
          <Card style={styles.listCard}>
            <View style={styles.list}>
              <View style={styles.rail} />
              {remaining.map((s, i) => (
                <StepRow
                  key={s.id}
                  title={s.title}
                  subtitle={s.subtitle}
                  done={false}
                  interactive={false}
                  upNext={i === 0}
                />
              ))}
            </View>
          </Card>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    fontSize: 12,
    letterSpacing: 1.44,
    textTransform: 'uppercase',
    color: colors.muted,
    fontWeight: '700',
    marginTop: 20,
    marginBottom: 10,
  },
  listCard: {
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  list: {
    position: 'relative',
  },
  // Connecting timeline rail, aligned with the step-node centers
  // (row padding 4 + node marginLeft 14 + node radius 14 = 32).
  rail: {
    position: 'absolute',
    left: 32,
    top: 26,
    bottom: 26,
    width: 2,
    borderRadius: 1,
    backgroundColor: colors.line,
  },
  pill: {
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
    flexShrink: 0,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.accent,
  },
  pillText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
    lineHeight: 18.2,
  },
  empty: {
    fontSize: 14,
    color: colors.muted,
  },
});
