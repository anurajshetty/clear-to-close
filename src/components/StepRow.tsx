// Clear to Close — checklist step row, built ONCE and reused everywhere.
//
// Interactive variant (realtor transaction view): tappable, drag grip, Custom
// tag on custom steps.
// Read-only variant (buyer/seller client views, interactive={false}): identical
// visuals — same node, rail geometry, titles, subtitles, UP NEXT tag — but the
// root is a plain View (NO onPress at all), there is no drag grip, and custom
// steps render exactly like normal steps (no Custom tag, no special styling).
import React, { ReactNode } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme';
import { Grip } from './ui';

type StepRowProps = {
  title: string;
  subtitle?: string;
  done: boolean;
  custom?: boolean;
} & (
  | {
      interactive?: true;
      onToggle: () => void;
      dragHandle?: ReactNode;
      upNext?: undefined;
      recent?: undefined;
    }
  | {
      interactive: false;
      onToggle?: undefined;
      dragHandle?: undefined;
      /** "Up next" tag on the first remaining step. */
      upNext?: boolean;
      /** "Just now" tag: checkoff still inside the recency window. */
      recent?: boolean;
    }
);

export function StepRow(props: StepRowProps) {
  const { title, subtitle, done } = props;
  const interactive = props.interactive !== false;

  const node = (
    <View style={[styles.node, done && styles.nodeDone]}>
      {done && (
        <Svg width={13} height={11} viewBox="0 0 11 9" aria-hidden={true}>
          <Path
            d="M1 4.5L4 7.5L10 1"
            stroke="#FFFFFF" strokeWidth={2.2}
            strokeLinecap="round" strokeLinejoin="round" fill="none"
          />
        </Svg>
      )}
    </View>
  );

  const titleText = (
    <Text style={[styles.title, done && styles.titleDone]}>
      {title}
      {interactive && props.custom ? (
        <Text style={styles.customTag}>  Custom</Text>
      ) : null}
      {!interactive && props.recent ? (
        <Text style={styles.justNowTag}>  Just now</Text>
      ) : null}
    </Text>
  );

  const body = (
    <>
      <View style={styles.body}>
        {titleText}
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        {!interactive && props.upNext && !done ? (
          <View style={styles.upNextWrap}>
            <Text style={styles.upNextTag}>Up next</Text>
          </View>
        ) : null}
      </View>
    </>
  );

  if (!interactive) {
    // Read-only client rows: a plain View — no onPress, no grip, no tag.
    // data-testid is for the automated "no interactivity" render check.
    return (
      <View style={styles.row} testID="client-step-row">
        {node}
        {body}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ checked: done }}
      onPress={props.onToggle}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
    >
      {node}
      {body}
      <View style={styles.gripZone}>{props.dragHandle ?? <Grip />}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    minHeight: 64, paddingVertical: 13, paddingHorizontal: 4,
  },
  node: {
    width: 28, height: 28, borderRadius: 14, flexShrink: 0,
    backgroundColor: colors.card, borderWidth: 2.5, borderColor: colors.photoBorder,
    alignItems: 'center', justifyContent: 'center', marginTop: 2, marginLeft: 14, marginRight: 14,
  },
  nodeDone: { backgroundColor: colors.accent, borderColor: colors.accent },
  body: { flex: 1, paddingTop: 1 },
  title: { fontSize: 15.5, fontWeight: '600', color: colors.ink },
  titleDone: { color: colors.body },
  subtitle: { fontSize: 13, color: colors.muted, marginTop: 3, lineHeight: 18.5 },
  customTag: {
    fontSize: 10, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase',
    color: colors.sellBrown, backgroundColor: colors.sellSoft, borderRadius: 5,
  },
  justNowTag: {
    fontSize: 10.5, fontWeight: '800', letterSpacing: 0.63, textTransform: 'uppercase',
    color: colors.accent, backgroundColor: colors.accentSoft, borderRadius: 6,
    paddingHorizontal: 8, paddingVertical: 2,
  },
  upNextWrap: { marginTop: 6, alignItems: 'flex-start' },
  upNextTag: {
    fontSize: 10.5, fontWeight: '800', letterSpacing: 0.84, textTransform: 'uppercase',
    color: colors.accent, backgroundColor: colors.accentSoft, borderRadius: 6,
    paddingVertical: 3, paddingHorizontal: 8,
  },
  gripZone: {
    flexShrink: 0, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8, paddingHorizontal: 4, minWidth: 44, minHeight: 44,
  },
});
