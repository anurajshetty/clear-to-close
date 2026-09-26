// Clear to Close — escrow time-tracker card
// Faithful to APPROVED mockup 01 · Escrow tracker v1.
import React from 'react';
import { Pressable, View, Text, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, radius } from '../theme';
import { Kicker, Card, SecondaryButton } from './ui';
import { daysToClose, timeline } from '../lib/dates';

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

/** Pencil icon beside each date row (mockup 01 · .penbtn): the approved SVG. */
function PencilIcon() {
  return (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={colors.muted}
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </Svg>
  );
}

function DateRow({ label, date, onEditDates, bordered }: {
  label: string; date: string; onEditDates?: () => void; bordered?: boolean;
}) {
  return (
    <View style={[styles.dateRow, bordered && styles.dateRowBorder]}>
      <Text style={styles.dateLabel}>{label}</Text>
      <View style={styles.dateValueRow}>
        <Text style={styles.dateValue}>{formatLongDate(date)}</Text>
        {onEditDates ? (
          <Pressable
            onPress={onEditDates}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${label.toLowerCase()} date`}
            style={styles.penBtn}
          >
            <PencilIcon />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function TimeTrackerCard({
  openDate, closeDate, onUpdateDate, onEditDates,
}: {
  openDate: string; closeDate: string; onUpdateDate?: () => void;
  /** When provided, a pencil affordance appears beside each date row. */
  onEditDates?: () => void;
}) {
  // One shared convention (src/lib/dates.ts): whole calendar days, DST-safe.
  // "day 1 of 61" always pairs with "61 days left to close".
  const { totalDays, dayNum } = timeline(openDate, closeDate);
  const daysLeft = daysToClose(closeDate);

  const state: 'normal' | 'warn' | 'over' =
    daysLeft < 0 ? 'over' : daysLeft <= 10 ? 'warn' : 'normal';
  const tone = state === 'warn' ? colors.amber : state === 'over' ? colors.red : colors.accent;

  const fillPct = Math.min(Math.max((dayNum / totalDays) * 100, 0), 100);

  return (
    <Card style={styles.card}>
      <View style={styles.kickWrap}>
        <Kicker>Escrow · time tracker</Kicker>
      </View>

      <DateRow label="Opened" date={openDate} onEditDates={onEditDates} />
      <DateRow label="Target close" date={closeDate} onEditDates={onEditDates} bordered />

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

      <Text testID="days-left" style={[styles.left, { color: state === 'normal' ? colors.ink : tone }]}>
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
  dateValueRow: { flexDirection: 'row', alignItems: 'center' },
  dateValue: { fontSize: 14.5, fontWeight: '700', color: colors.ink },
  // Pencil affordance beside each date (mockup 01 · .penbtn): 44pt tap
  // target, muted — opens the "Edit dates" sheet.
  penBtn: {
    width: 44, height: 44, marginRight: -12,
    alignItems: 'center', justifyContent: 'center',
  },
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
  left: {
    fontSize: 14.5, fontWeight: '700', marginTop: 12,
    // "N days left to close" is centered (per Anuraj, Sept 25).
    textAlign: 'center',
  },
  updateBtn: { marginTop: 10 },
});
