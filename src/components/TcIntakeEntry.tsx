// Clear to Close — shared TC intake entry card (Sept 29, 2026,
// Anuraj-approved mockup 04).
//
// One component for two approved surfaces, matching the KeyDatesEntryPoint
// structural pattern (accent icon circle + bold title + quiet caption +
// trailing chevron, 48px target):
//   (a) the realtor's "TC intake" entry row on the transaction screen —
//       clipboard icon, caption = status ("Not started" / "X of Y filled" /
//       "Complete"), trailing chevron when nothing is saved and the
//       pencil-once-saved (Sept 29: "pencil-once-saved" — tapping always
//       opens the editable form either way);
//   (b) the TC's "View listing details" card — stroked eye in the
//       accent treatment (same glyph as ui.tsx EyeIcon, accent colored
//       per the mockup), caption "Listing information from your realtor",
//       always a chevron.
// The pencil glyph is the Material "edit" path used on the deal cards
// (DealCard.tsx).
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { Kicker } from './ui';
import { buildTcIntakeSections, type TcIntakeData } from '../lib/tcIntake';
import { colors } from '../theme';

export interface TcEntryCardProps {
  /** Bold title: "TC intake" (realtor) or "View listing details" (TC). */
  title: string;
  /** Quiet caption: the status line (realtor) or "Listing information from your realtor" (TC). */
  caption: string;
  /** Realtor row: clipboard. TC card: eye. */
  icon: 'clipboard' | 'eye';
  /** Realtor row: 'pencil' once anything is saved, else 'chevron'. TC card: 'chevron'. */
  trailing: 'chevron' | 'pencil';
  onPress: () => void;
  accessibilityLabel: string;
  accessibilityHint: string;
  testID?: string;
}

function ClipboardIcon() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
      <Rect x={8} y={2} width={8} height={4} rx={1} stroke={colors.accent} strokeWidth={2} />
      <Path
        d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"
        stroke={colors.accent}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path d="M9 12h6M9 16h6" stroke={colors.accent} strokeWidth={2} strokeLinecap="round" />
    </Svg>
  );
}

function AccentEyeIcon() {
  // Same stroked-eye glyph as ui.tsx EyeIcon, in the mockup's accent
  // treatment (accent circle + accentSoft fill).
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
      <Path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
        stroke={colors.accent}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Circle cx={12} cy={12} r={3} stroke={colors.accent} strokeWidth={2} />
    </Svg>
  );
}

const PENCIL_PATH =
  'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';

export function TcEntryCard({
  title,
  caption,
  icon,
  trailing,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: TcEntryCardProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.75 }]}
    >
      <View style={styles.iconCircle} aria-hidden={true}>
        {icon === 'clipboard' ? <ClipboardIcon /> : <AccentEyeIcon />}
      </View>
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.caption}>{caption}</Text>
      </View>
      {trailing === 'pencil' ? (
        <Svg width={20} height={20} viewBox="0 0 24 24" aria-hidden={true}>
          <Path d={PENCIL_PATH} fill={colors.accent} />
        </Svg>
      ) : (
        <Text style={styles.chevron} aria-hidden={true}>
          ›
        </Text>
      )}
    </Pressable>
  );
}


/**
 * Read-only section renderer (mockup ⑤): all six sections, label + value
 * rows, unfilled values in the muted "Not provided" treatment. Shared by
 * the TC details page and the realtor's LOCKED intake form (closed/
 * cancelled escrows) — one renderer, no divergent copies.
 */
export function TcIntakeSections({
  data,
  fullAddress,
}: {
  data: TcIntakeData;
  fullAddress: string;
}) {
  const sections = buildTcIntakeSections(data, fullAddress);
  return (
    <View style={styles.detailsCard}>
      <Kicker>From your realtor</Kicker>
      {sections.map((sec) => (
        <View key={sec.title} style={styles.sumsec}>
          <Text style={styles.secLabel}>{sec.title}</Text>
          {sec.rows.map((r) => (
            <View key={r.label} style={styles.kvRow}>
              <Text style={styles.kvLabel}>{r.label}</Text>
              <Text
                style={[styles.kvValue, !r.provided && styles.kvValueEmpty]}
                testID={r.provided ? undefined : 'not-provided'}
              >
                {r.value}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 48,
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginBottom: 18,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  text: {
    flex: 1,
    flexShrink: 1,
  },
  title: {
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.ink,
  },
  caption: {
    fontSize: 12.5,
    fontWeight: '600',
    color: colors.muted,
    marginTop: 2,
  },
  chevron: {
    fontSize: 22,
    color: colors.muted,
    lineHeight: 24,
    flexShrink: 0,
  },
  detailsCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 18,
  },
  sumsec: {
    marginTop: 14,
  },
  secLabel: {
    fontSize: 12,
    letterSpacing: 1.5,
    textTransform: 'uppercase',
    color: colors.muted,
    fontWeight: '700',
    marginBottom: 6,
  },
  kvRow: {
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  kvLabel: {
    fontSize: 12.5,
    fontWeight: '700',
    color: colors.muted,
    marginBottom: 2,
  },
  kvValue: {
    fontSize: 15,
    color: colors.ink,
  },
  kvValueEmpty: {
    color: colors.muted,
    fontStyle: 'italic',
  },
});
