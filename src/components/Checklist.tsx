// Clear to Close — shared single-list checklist, built ONCE and reused everywhere.
//
// Faithful to APPROVED mockup 01 · devices 2/3/12 (realtor editable) and
// 4/5/11/14 (client read-only): ONE ordered list in the realtor's order — no
// Completed/Remaining grouping, NO continuous full-height spine — only short
// connector segments between consecutive circles. Checked steps stay in place;
// the check circle just fills in.
//
// Scroll-safety (realtor 6-of-13 cutoff, Sept 2026 — root-caused with real
// rendered geometry): on web, DraggableFlatList wraps its inner ScrollView in
// an extra outer container div. The screen used to bound only the inner list
// style, so the unbounded wrapper grew to the full content height, the inner
// ScrollView became content-sized, and its scroll range collapsed to zero —
// steps below the fold were unreachable (body is overflow:hidden on web, so
// there is no fallback scroll context). This component bounds the OUTER
// container (containerStyle flex:1) AND re-asserts `touch-action: pan-y` on it
// for web (react-native-gesture-handler stamps touch-action:none on the
// wrapper, which kills native touch scrolling on mobile browsers even with a
// bounded height). `touch-action: none` is scoped to the drag grip alone, so
// drag-reorder and touch scroll work together.
//
// Regression guard: tests/realtor_checklist_scroll.py drives the real built
// output, scrolls the list with the native setter (RNW overrides scrollTo),
// and asserts the LAST step is visible in the viewport. Unit tests were all
// green during the cutoff bug (the data was correct) — only rendered geometry
// caught it, so the guard asserts the visible outcome.
import React, { ReactElement, ReactNode, useCallback } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';
import { Card, Grip } from './ui';
import { StepRow } from './StepRow';
import type { StepT } from '../lib/types';
import { isRecent } from '../lib/recency';
import { mostRecentCheckoff } from '../lib/clientView';
import { colors } from '../theme';

// Circle geometry (must match StepRow): row paddingHorizontal 4 + node
// marginLeft 14 + node radius 14 = circle center x 32; row paddingTop 13 +
// node marginTop 2 = circle top 15; circle bottom 15 + 28 = 43.
const CONN_LEFT = 31;
const CIRCLE_TOP = 15;
const CIRCLE_BOTTOM = 43;

/**
 * Wraps one step row and draws the short connector segments between
 * consecutive circles — the segment above (from this row's top to its
 * circle top) for every row but the first, and the segment below (from its
 * circle bottom to the row's bottom) for every row but the last. Nothing
 * above the first circle, nothing below the last — never a full-height spine.
 */
export function ChecklistRow({
  index,
  count,
  children,
}: {
  index: number;
  count: number;
  children: ReactNode;
}) {
  return (
    <View style={styles.rowWrap}>
      {index > 0 ? <View style={styles.connTop} testID="step-connector" /> : null}
      {index < count - 1 ? <View style={styles.connBottom} testID="step-connector" /> : null}
      {children}
    </View>
  );
}

// Web: re-assert pan-y on the DraggableFlatList outer wrapper so vertical
// touch drags scroll the list. Mouse-driven drag-reorder is unaffected
// (touch-action only governs touch input); on native the gesture system
// handles scroll + drag, so this is a no-op there.
function allowTouchScroll({ containerRef }: { containerRef: React.RefObject<View> }) {
  if (Platform.OS !== 'web') return;
  const el = containerRef.current as unknown as { style?: CSSStyleDeclaration } | null;
  if (el?.style && el.style.touchAction !== 'pan-y') {
    el.style.touchAction = 'pan-y';
  }
}

export type EditableChecklistProps = {
  steps: StepT[];
  /** Both-mode row tag (mockup 01 · device 12). Undefined on single-side lists. */
  sideTag?: 'Buyer' | 'Seller';
  onToggle: (stepId: string) => void;
  onReorder: (orderedIds: string[]) => void;
  ListHeaderComponent?: ReactElement | null;
  ListFooterComponent?: ReactElement | null;
};

/**
 * Realtor editable checklist: tap check/uncheck in place, drag grips on all
 * rows, UP NEXT on the first remaining step, Custom tag on custom steps.
 * The list itself is the bounded scroll container (see the scroll-safety
 * note above) — it must fill the remaining viewport space.
 */
export function EditableChecklist({
  steps,
  sideTag,
  onToggle,
  onReorder,
  ListHeaderComponent,
  ListFooterComponent,
}: EditableChecklistProps) {
  const upNextId = steps.find((s) => !s.done)?.id;

  const renderGrip = useCallback(
    (title: string, drag: () => void) => (
      <Pressable
        onPressIn={drag}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Drag to reorder ${title}`}
        style={styles.gripHit}
      >
        <Grip />
      </Pressable>
    ),
    [],
  );

  return (
    <DraggableFlatList
      data={steps}
      keyExtractor={(s) => s.id}
      style={styles.list}
      // Bounds the OUTER wrapper to the remaining viewport space: without
      // this the inner ScrollView grows to its full content height on web and
      // the steps below the fold become unreachable (no scroll container is
      // ever created).
      containerStyle={styles.listContainer}
      onContainerLayout={allowTouchScroll}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={ListHeaderComponent}
      renderItem={({ item, getIndex, drag }) => (
        <ChecklistRow index={getIndex() ?? 0} count={steps.length}>
          <StepRow
            title={item.title}
            subtitle={item.subtitle}
            done={item.done}
            custom={item.custom}
            sideTag={sideTag}
            upNext={item.id === upNextId}
            onToggle={() => onToggle(item.id)}
            dragHandle={renderGrip(item.title, drag)}
          />
        </ChecklistRow>
      )}
      onDragEnd={({ data }) => onReorder(data.map((s) => s.id))}
      ListFooterComponent={ListFooterComponent}
    />
  );
}

/**
 * Client read-only checklist: the same single ordered list — checked steps in
 * place, UP NEXT on the first remaining step, JUST NOW tag while the checkoff
 * is inside the recency window — but rows are plain Views (no tap targets),
 * no drag grips, and custom steps render exactly like default steps.
 */
export function ReadOnlyChecklist({ steps, now }: { steps: StepT[]; now?: number }) {
  // Computed once at render from the device clock — no live ticking.
  const t = now ?? Date.now();
  const upNextId = steps.find((s) => !s.done)?.id;
  return (
    <Card style={styles.listCard}>
      {steps.map((s, i) => (
        <ChecklistRow key={s.id} index={i} count={steps.length}>
          <StepRow
            interactive={false}
            title={s.title}
            subtitle={s.subtitle}
            done={s.done}
            upNext={s.id === upNextId}
            recent={isRecent(s.completedAt, t)}
          />
        </ChecklistRow>
      ))}
    </Card>
  );
}

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
      <Text style={styles.pillText}>Your realtor checked off “{recent.title}” just now.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  rowWrap: {
    position: 'relative',
  },
  connTop: {
    position: 'absolute',
    left: CONN_LEFT,
    top: 0,
    height: CIRCLE_TOP,
    width: 2,
    backgroundColor: colors.line,
  },
  connBottom: {
    position: 'absolute',
    left: CONN_LEFT,
    top: CIRCLE_BOTTOM,
    bottom: 0,
    width: 2,
    backgroundColor: colors.line,
  },
  list: {
    flex: 1,
  },
  listContainer: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: 18,
    paddingTop: 4,
    paddingBottom: 36,
  },
  listCard: {
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  // touch-action:none is scoped to the drag grip ONLY: a touch-drag starting
  // on the grip reorders instead of scrolling, while the list container keeps
  // pan-y so finger drags anywhere else scroll (mockup 01: .grip touch-action:none).
  gripHit: {
    ...(Platform.OS === 'web' ? ({ touchAction: 'none' } as object) : null),
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
});
