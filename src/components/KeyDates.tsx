// Clear to Close — key dates entry point + sheet (FINAL spec, Sept 28,
// 2026, Anuraj-approved; mockups 01-keydates-sheet-entry /
// 01-keydates-sheet-open).
//
// Entry point: directly below LATEST FROM on every client view — calendar
// glyph + bold "Key dates" + the most urgent date as a quiet hint
// ("Appraisal deadline · overdue by 4 days": red when overdue, amber at 7
// days or fewer, muted otherwise) + chevron. A real 48px button target.
//
// Inspection contingency deadline -> Release contingency deadline (Anuraj,
// Sept 30, 2026): the user-facing label was renamed; the internal field
// stays `inspectionDeadline`.
// Tap opens the bottom sheet (the app's sheet pattern: grabber, ×, title)
// with the four rows — Closing date (= the existing target close),
// Release contingency deadline, Appraisal deadline, Loan approval date —
// each with date + relative line computed at render, never ticking: muted
// for future dates, amber within 7 days (including today), red date + red
// line when overdue. A cleared date shows the neutral "Not set" row
// (muted, never amber/red). Empty state (no realtor-entered dates): a single
// quiet line, "No key dates yet. Your realtor adds them here."
//
// The sheet closes via ×, tap-outside, grabber drag, or Esc (web). Focus
// moves to the × on open and returns to the entry point on close (web).
import React, { useEffect, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';
import { Sheet } from './ui';
import {
  describeKeyDate,
  mostUrgentKeyDate,
  todayLocal,
  type KeyDateTone,
} from '../lib/keyDates';
import { colors } from '../theme';

export interface KeyDates {
  /** Closing date = the existing target close (always present). */
  closeDate: string;
  inspectionDeadline?: string | null;
  appraisalDeadline?: string | null;
  loanApprovalDate?: string | null;
  /** Override for tests; defaults to the client-local today. */
  today?: string;
}

const ROW_LABELS = {
  close: 'Closing date',
  inspection: 'Release contingency deadline',
  appraisal: 'Appraisal deadline',
  loan: 'Loan approval date',
} as const;

function CalendarIcon() {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none" aria-hidden={true}>
      <Rect x={2.5} y={4.5} width={15} height={13} rx={2.5} stroke={colors.accent} strokeWidth={1.6} />
      <Line x1={2.5} y1={8.5} x2={17.5} y2={8.5} stroke={colors.accent} strokeWidth={1.6} />
      <Line x1={7} y1={2.5} x2={7} y2={6} stroke={colors.accent} strokeWidth={1.6} strokeLinecap="round" />
      <Line x1={13} y1={2.5} x2={13} y2={6} stroke={colors.accent} strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

function hintStyle(tone: KeyDateTone) {
  if (tone === 'over') return styles.hintOver;
  if (tone === 'soon') return styles.hintSoon;
  return styles.hint;
}

/**
 * The tappable entry point: calendar glyph + bold "Key dates" + the most
 * urgent date as a quiet hint + chevron. 48px button target, directly below
 * LATEST FROM on every client view.
 */
export function KeyDatesEntryPoint({ onPress, ...dates }: KeyDates & { onPress: () => void }) {
  const today = dates.today ?? todayLocal();
  const urgent = mostUrgentKeyDate(
    [
      { label: ROW_LABELS.close, date: dates.closeDate },
      { label: ROW_LABELS.inspection, date: dates.inspectionDeadline },
      { label: ROW_LABELS.appraisal, date: dates.appraisalDeadline },
      { label: ROW_LABELS.loan, date: dates.loanApprovalDate },
    ],
    today,
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={urgent ? `Key dates. ${urgent.hint}.` : 'Key dates'}
      accessibilityHint="Shows the closing date, inspection deadline, appraisal deadline, and loan approval date."
      onPress={onPress}
      // Stable DOM id on web: the sheet returns focus here on close.
      nativeID="key-dates-entry"
      testID="key-dates-entry"
      style={styles.entry}
    >
      <View style={styles.iconCircle} aria-hidden={true}>
        <CalendarIcon />
      </View>
      <Text style={styles.entryLabel}>Key dates</Text>
      {urgent ? (
        <Text style={hintStyle(urgent.tone)} numberOfLines={2}>
          {urgent.hint}
        </Text>
      ) : null}
      <Text style={styles.entryChevron} aria-hidden={true}>
        ›
      </Text>
    </Pressable>
  );
}

function toneStyles(tone: KeyDateTone) {
  if (tone === 'over') return { date: styles.dateOver, when: styles.whenOver };
  if (tone === 'soon') return { date: styles.date, when: styles.whenSoon };
  return { date: styles.date, when: styles.when };
}

function KeyDateRow({
  label,
  date,
  today,
}: {
  label: string;
  /** Null = cleared or never set: renders the neutral "Not set" treatment
   * (Sept 28, 2026, Anuraj-approved) — muted, never amber/red, never a
   * crash. Cleared dates stay visible as rows so the client sees the date
   * is intentionally absent, not missing. */
  date: string | null;
  today: string;
}) {
  const line = date ? describeKeyDate(date, today) : null;
  const tone = line ? toneStyles(line.tone) : null;
  return (
    <View style={styles.row} testID={`key-date-row-${label}`}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.dateWrap}>
        {line && tone ? (
          <>
            <Text style={tone.date}>{line.dateLabel}</Text>
            <Text style={tone.when}>{line.when}</Text>
          </>
        ) : (
          <Text style={styles.when}>Not set</Text>
        )}
      </View>
    </View>
  );
}

/** The four rows (or the quiet empty line) — shared by the sheet. */
export function KeyDatesRows({
  closeDate,
  inspectionDeadline,
  appraisalDeadline,
  loanApprovalDate,
  today,
}: KeyDates) {
  const now = today ?? todayLocal();
  const rows = [
    { label: ROW_LABELS.close, date: closeDate },
    { label: ROW_LABELS.inspection, date: inspectionDeadline ?? null },
    { label: ROW_LABELS.appraisal, date: appraisalDeadline ?? null },
    { label: ROW_LABELS.loan, date: loanApprovalDate ?? null },
  ];
  // The three realtor-entered dates are what makes the sheet real: when
  // none are set, the sheet shows only the quiet empty line.
  const hasKeyDates = rows.slice(1).some((r) => r.date);
  if (!hasKeyDates) {
    return (
      <Text style={styles.empty} testID="key-dates-empty">
        No key dates yet. Your realtor adds them here.
      </Text>
    );
  }
  // Cleared dates render as rows with the neutral "Not set" treatment
  // (never skipped, never urgency-colored).
  return (
    <View style={styles.rows}>
      {rows.map((r) => (
        <KeyDateRow key={r.label} label={r.label} date={r.date} today={now} />
      ))}
    </View>
  );
}

/** The bottom sheet opened from the entry point (mockup 01-keydates-sheet-open). */
export function KeyDatesSheet({
  visible,
  onClose,
  ...dates
}: KeyDates & { visible: boolean; onClose: () => void }) {
  // Web-only dialog behavior: Esc closes; focus moves to the × on open and
  // returns to the entry point on close. Native needs none of this.
  const closeRef = useRef<View>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (!visible) {
      // Return focus to the entry point once the sheet is gone.
      const t = window.setTimeout(() => {
        document.getElementById('key-dates-entry')?.focus();
      }, 60);
      return () => window.clearTimeout(t);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => {
      try {
        (closeRef.current as unknown as HTMLElement | null)?.focus?.();
      } catch {
        // focus is best-effort
      }
    }, 60);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [visible, onClose]);

  return (
    <Sheet visible={visible} onClose={onClose} dragToDismiss>
      <View testID="key-dates-sheet">
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Key dates</Text>
          <Pressable
            ref={closeRef}
            accessibilityRole="button"
            accessibilityLabel="Close key dates"
            onPress={onClose}
            testID="key-dates-close"
            style={styles.closeBtn}
          >
            <Text style={styles.closeX} aria-hidden={true}>
              ×
            </Text>
          </Pressable>
        </View>
        <KeyDatesRows {...dates} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 48,
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 18,
  },
  iconCircle: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  entryLabel: {
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.ink,
    flex: 1,
    flexShrink: 1,
  },
  hint: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.muted,
    textAlign: 'right',
    flexShrink: 1,
  },
  hintSoon: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.amber,
    textAlign: 'right',
    flexShrink: 1,
  },
  hintOver: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.red,
    textAlign: 'right',
    flexShrink: 1,
  },
  entryChevron: {
    fontSize: 22,
    color: colors.muted,
    lineHeight: 24,
    flexShrink: 0,
  },
  sheetHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.ink,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.card,
  },
  closeX: {
    fontSize: 20,
    color: colors.red,
    lineHeight: 22,
  },
  rows: {
    marginTop: 6,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  label: {
    fontSize: 14,
    color: colors.muted,
    flexShrink: 1,
  },
  dateWrap: {
    alignItems: 'flex-end',
    flexShrink: 0,
  },
  date: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'right',
  },
  when: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.muted,
    marginTop: 2,
    textAlign: 'right',
  },
  whenSoon: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.amber,
    marginTop: 2,
    textAlign: 'right',
  },
  dateOver: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.red,
    textAlign: 'right',
  },
  whenOver: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.red,
    marginTop: 2,
    textAlign: 'right',
  },
  empty: {
    fontSize: 13.5,
    color: colors.muted,
    lineHeight: 20,
    marginTop: 10,
  },
});
