// Clear to Close — escrow time-tracker card
// Faithful to APPROVED mockup 01 · Escrow tracker v1.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, radius } from '../theme';
import { Kicker, Card, SecondaryButton } from './ui';

const DAY = 86400000;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Parse 'YYYY-MM-DD' as a LOCAL date (never UTC).
function parseLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// "2026-08-28" -> "Aug 28"
export function formatShortDate(iso: string): string {
  const dt = parseLocal(iso);
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}`;
}

function formatLongDate(iso: string): string {
  const dt = parseLocal(iso);
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

function daysLabel(n: number, past: boolean): string {
  const unit = Math.abs(n) === 1 ? 'day' : 'days';
  return past ? `${n} ${unit} past target close` : `${n} ${unit} left to close`;
}

export function TimeTrackerCard({
  openDate, closeDate, onUpdateDate,
}: {
  openDate: string; closeDate: string; onUpdateDate?: () => void;
}) {
  const open = parseLocal(openDate);
  const close = parseLocal(closeDate);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const totalDays = Math.max(1, Math.round((close.getTime() - open.getTime()) / DAY));
  const dayNum = Math.min(Math.max(Math.round((today.getTime() - open.getTime()) / DAY) + 1, 1), totalDays);
  const daysLeft = Math.ceil((close.getTime() - today.getTime()) / DAY);

  const state: 'normal' | 'warn' | 'over' =
    daysLeft < 0 ? 'over' : daysLeft <= 10 ? 'warn' : 'normal';
  const tone = state === 'warn' ? colors.amber : state === 'over' ? colors.red : colors.accent;

  const fillPct = Math.min(Math.max((dayNum / totalDays) * 100, 0), 100);

  return (
    <Card style={styles.card}>
      <View style={styles.kickWrap}>
        <Kicker>Escrow · time tracker</Kicker>
      </View>

      <View style={styles.dateRow}>
        <Text style={styles.dateLabel}>Opened</Text>
        <Text style={styles.dateValue}>{formatLongDate(openDate)}</Text>
      </View>
      <View style={[styles.dateRow, styles.dateRowBorder]}>
        <Text style={styles.dateLabel}>Target close</Text>
        <Text style={styles.dateValue}>{formatLongDate(closeDate)}</Text>
      </View>

      <View
        style={styles.bar}
        accessibilityRole="image"
        accessibilityLabel={
          state === 'over'
            ? `${Math.abs(daysLeft)} days past target close.`
            : `Day ${dayNum} of ${totalDays}. ${daysLeft} days left to close.`
        }
      >
        <View style={[styles.fill, { width: `${fillPct}%`, backgroundColor: tone }]} />
        {state !== 'over' && (
          <View style={[styles.todayDot, { left: `${fillPct}%`, borderColor: tone }]} />
        )}
      </View>

      <View style={styles.labels}>
        <Text style={styles.labelSide}>{formatShortDate(openDate)}</Text>
        <Text style={styles.labelNow}>Today · day {dayNum} of {totalDays}</Text>
        <Text style={styles.labelSide}>{formatShortDate(closeDate)}</Text>
      </View>

      <Text style={[styles.left, { color: state === 'normal' ? colors.ink : tone }]}>
        {daysLabel(state === 'over' ? Math.abs(daysLeft) : daysLeft, state === 'over')}
      </Text>

      {state === 'over' && onUpdateDate && (
        <View style={styles.updateBtn}>
          <SecondaryButton title="Update target date" onPress={onUpdateDate} />
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { borderTopWidth: 3, borderTopColor: colors.accent },
  kickWrap: { marginBottom: 8 },
  dateRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 9,
  },
  dateRowBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  dateLabel: { fontSize: 14.5, color: colors.muted },
  dateValue: { fontSize: 14.5, fontWeight: '700', color: colors.ink },
  bar: {
    position: 'relative', height: 8, backgroundColor: colors.line,
    borderRadius: 99, marginTop: 14, marginBottom: 8, overflow: 'visible',
  },
  fill: { height: '100%', borderRadius: 99 },
  todayDot: {
    position: 'absolute', top: 4, width: 15, height: 15, borderRadius: 99,
    backgroundColor: '#FFFFFF', borderWidth: 3.5,
    marginLeft: -7.5, marginTop: -7.5,
  },
  labels: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
  },
  labelSide: { fontSize: 11.5, color: colors.muted },
  labelNow: { fontSize: 12.5, fontWeight: '800', color: colors.ink },
  left: { fontSize: 14.5, fontWeight: '700', marginTop: 12 },
  updateBtn: { marginTop: 10 },
});
