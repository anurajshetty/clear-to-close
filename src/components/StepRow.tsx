// Clear to Close — checklist step row, built ONCE and reused everywhere.
//
// Faithful to APPROVED mockup 01 · device 2/3 (realtor editable) and 4/5/11/14
// (client read-only), reworked Sept 26: node + drag grip + body order, short
// connector segments are drawn by the Checklist wrapper (no continuous spine),
// Custom tag on the realtor view only, UP NEXT on the first remaining step on
// BOTH variants. No recency markers (removed per Anuraj's review, Sept 26).
//
// Interactive variant (realtor transaction view): tappable, drag grip on every
// row, Custom tag on custom steps.
// Read-only variant (buyer/seller client views, interactive={false}): identical
// visuals — same node, connectors, titles, subtitles, UP NEXT tag — but the
// root is a plain View (NO onPress at all), there is no drag grip, and custom
// steps render exactly like normal steps (no Custom tag, no special styling).
import React, { ReactNode, useRef, useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme';
import { Grip } from './ui';

type StepRowBase = {
  title: string;
  subtitle?: string;
  done: boolean;
  custom?: boolean;
  /** Both-mode row tag (mockup 01 · device 12). Undefined on single-side lists. */
  sideTag?: 'Buyer' | 'Seller';
  /** "Up next" tag on the first remaining step — both variants. */
  upNext?: boolean;
};

type StepRowProps = StepRowBase &
  (
    | {
        interactive?: true;
        onToggle: () => void;
        dragHandle?: ReactNode;
        /** Library drag-arm callback (renderItem `drag`) — row long-press. */
        onDragStart: () => void;
        /** True while this row is the active drag row (library `isActive`). */
        active?: boolean;
      }
    | {
        interactive: false;
        onToggle?: undefined;
        dragHandle?: undefined;
      }
  );

export function StepRow(props: StepRowProps) {
  const { title, subtitle, done } = props;
  const interactive = props.interactive !== false;

  const node = (
    <View style={[styles.node, done && styles.nodeDone]}>
      {done && (
        <Svg width={13} height={11} viewBox="0 0 13 11" aria-hidden={true}>
          <Path
            d="M1.5 5.8L5 9.3L11.5 1.5"
            stroke="#FFFFFF"
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </Svg>
      )}
    </View>
  );

  const titleText = (
    <Text style={[styles.title, done && styles.titleDone]}>
      {title}
      {props.sideTag ? (
        <Text style={[styles.sideTag, props.sideTag === 'Seller' && styles.sideTagSeller]}>
          {'  '}
          {props.sideTag}
        </Text>
      ) : null}
      {interactive && props.custom ? <Text style={styles.customTag}>  Custom</Text> : null}
    </Text>
  );

  const body = (
    <View style={[styles.body, !interactive && styles.bodyNoGrip]}>
      {titleText}
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {props.upNext && !done ? (
        <View style={styles.upNextWrap}>
          <Text style={styles.upNextTag}>Up next</Text>
        </View>
      ) : null}
    </View>
  );

  if (!interactive) {
    // Read-only client rows: a plain View — no onPress, no grip, no Custom tag.
    // data-testid is for the automated "no interactivity" render check.
    return (
      <View style={styles.row} testID="client-step-row">
        {node}
        {body}
      </View>
    );
  }

  // Realtor rows, Sept 2026: the check circle is its own pressable — tap
  // toggles, long-press does nothing and never arms a drag. The rest of the
  // row (text included) long-presses to arm the drag; a quick tap on the row
  // text is inert. The grip keeps its long-press-to-drag.
  const suppressCheckboxToggle = useRef(false);
  const [checkboxPressed, setCheckboxPressed] = useState(false);

  return (
    <Pressable
      testID="step-row"
      // Not a button: the row body is a drag surface, not a tap target. The
      // checkbox (toggle) and the grip (reorder) carry their own semantics.
      onPress={() => {
        // Quick tap on row text stays inert by design (Sept 2026): only the
        // check circle toggles, and only a long-press arms the drag. A
        // release right after a drag-arming long-press lands here too and
        // must not toggle the step.
      }}
      onLongPress={() => {
        props.onDragStart();
      }}
      // Active drag row: lifted card — solid background so it occludes the
      // rows it passes over (mid-drag text collision, Sept 2026), slight
      // scale + shadow + zIndex so it reads as floating above the list.
      // Resting rows are untouched (no card background per the mockup).
      style={({ pressed }) => [
        styles.row,
        (pressed || checkboxPressed) && { opacity: 0.7 },
        props.active && styles.rowActive,
      ]}
    >
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={`${title}. ${done ? 'completed. Activate to undo.' : 'not completed. Activate to check off.'}`}
        testID={`step-checkbox-${props.title}`}
        hitSlop={10}
        onPressIn={() => {
          setCheckboxPressed(true);
          suppressCheckboxToggle.current = false;
        }}
        onPressOut={() => setCheckboxPressed(false)}
        onPress={() => {
          // A checkbox long-press must never toggle.
          if (suppressCheckboxToggle.current) {
            suppressCheckboxToggle.current = false;
            return;
          }
          props.onToggle();
        }}
        onLongPress={() => {
          suppressCheckboxToggle.current = true;
        }}
      >
        {node}
      </Pressable>
      <View style={styles.gripZone}>{props.dragHandle ?? <Grip />}</View>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    minHeight: 64,
    paddingVertical: 13,
    paddingHorizontal: 4,
  },
  node: {
    width: 28,
    height: 28,
    borderRadius: 14,
    flexShrink: 0,
    backgroundColor: colors.card,
    borderWidth: 2.5,
    borderColor: colors.photoBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
    marginLeft: 14,
  },
  nodeDone: { backgroundColor: colors.accent, borderColor: colors.accent },
  // Drag grip sits BETWEEN the node and the body (mockup 01 row order:
  // node + grip + sbody), with 14px gaps on both sides.
  gripZone: {
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 4,
    marginHorizontal: 10,
    minWidth: 44,
    minHeight: 44,
  },
  body: { flex: 1, paddingTop: 1 },
  // Active drag row (see the Pressable above): a lifted card. The solid
  // background is what keeps the dragged title from painting over in-flow
  // rows mid-drag; scale + shadow sell the lift. Web: RNW maps the shadow
  // props to box-shadow; the library's cell wrapper already sets zIndex 999.
  rowActive: {
    backgroundColor: colors.card,
    borderRadius: 12,
    transform: [{ scale: 1.03 }],
    shadowColor: '#000000',
    shadowOpacity: 0.16,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
    zIndex: 10,
  },
  // Read-only rows have no grip: keep the same 14px icon-to-text gap.
  bodyNoGrip: { marginLeft: 14 },
  title: { fontSize: 15.5, fontWeight: '600', color: colors.ink },
  titleDone: { color: colors.body },
  subtitle: { fontSize: 13, color: colors.muted, marginTop: 3, lineHeight: 18.5 },
  sideTag: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    borderRadius: 5,
  },
  sideTagSeller: {
    color: colors.sellBrown,
    backgroundColor: colors.sellSoft,
  },
  customTag: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: colors.sellBrown,
    backgroundColor: colors.sellSoft,
    borderRadius: 5,
  },
  upNextWrap: { marginTop: 6, alignItems: 'flex-start' },
  upNextTag: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.84,
    textTransform: 'uppercase',
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
});
