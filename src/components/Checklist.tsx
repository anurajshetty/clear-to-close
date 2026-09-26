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
import React, { ReactElement, ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DraggableFlatList from 'react-native-draggable-flatlist';
import { Card, Grip } from './ui';
import { StepRow } from './StepRow';
import type { StepT } from '../lib/types';
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

  // Web: the draggable list's autoscroll holds stale Reanimated state after a
  // drag (Sept 2026 — an up-drag followed by a down-drag never autoscrolls;
  // the library's reset() does not clear it). Remounting on order change
  // clears it. Scroll position is preserved across the remount so the list
  // does not jump.
  const orderKey = steps.map((s) => s.id).join(',');
  const containerElRef = useRef<HTMLElement | null>(null);
  const pendingScrollRef = useRef<number | null>(null);

  function findScroller(el: HTMLElement | null): HTMLElement | null {
    if (Platform.OS !== 'web') return null;
    // Prefer the checklist container; fall back to the document if the ref
    // is stale (e.g. mid-remount).
    const root: HTMLElement | null =
      el && el.isConnected ? el : (document.body as HTMLElement);
    let best: HTMLElement | null = null;
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      const c = all[i] as HTMLElement;
      if (c.scrollHeight > c.clientHeight + 4 && c.scrollHeight > 200) {
        if (!best || c.scrollHeight > best.scrollHeight) best = c;
      }
    }
    return best;
  }

  useLayoutEffect(() => {
    if (pendingScrollRef.current != null && Platform.OS === 'web') {
      const target = pendingScrollRef.current;
      pendingScrollRef.current = null;
      // Defer to the next frame: the remounted list's ScrollView may not be
      // laid out yet when this effect runs.
      requestAnimationFrame(() => {
        const scroller = findScroller(containerElRef.current);
        if (scroller) scroller.scrollTop = target;
      });
    }
  }, [orderKey]);

  const onContainerLayout = useCallback(
    ({ containerRef }: { containerRef: React.RefObject<View> }) => {
      allowTouchScroll({ containerRef });
      if (Platform.OS === 'web') {
        containerElRef.current = containerRef.current as unknown as HTMLElement | null;
      }
    },
    [],
  );

  // Web touch-drag from the row (Sept 2026): the list container is
  // touch-action pan-y so finger drags scroll, which means the browser would
  // otherwise claim a row-drag touch for native scrolling the moment the
  // finger moves — the library's Pan gesture would never see the moves and an
  // armed row drag would die. While a drag is active, preventDefault the
  // touchmove so the Pan gesture tracks the finger (the grip already works
  // because it is touch-action none). Native is untouched: the gesture
  // system arbitrates there.
  const dragActiveRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const prevent = (e: TouchEvent) => {
      if (dragActiveRef.current) e.preventDefault();
    };
    window.addEventListener('touchmove', prevent, { passive: false });
    return () => window.removeEventListener('touchmove', prevent);
  }, []);

  // Drag-reorder safety (Sept 2026 — live bug, root-caused with real gestures):
  // the grip used to call drag() on onPressIn — i.e. on touchstart/mousedown,
  // BEFORE any movement or hold. That instantly set the library's active cell,
  // which arms its autoscroll reaction; with a stale cell measurement (right
  // after a data change, e.g. a freshly added custom row) or a row sitting at
  // a viewport edge, the autoscroll edge math fired with zero user intent and
  // flung the list to the top — the press never became a drag and the user
  // lost their row. The fix (the library's documented pattern): arm the drag
  // on LONG-PRESS only, so a drag — and its autoscroll — can never start from
  // a bare press. A quick tap on the grip is now inert; press-and-hold, then
  // drag. The 500ms hold also lets cell measurements settle after data
  // changes before the drag-start snapshot is taken.
  const renderGrip = useCallback(
    (title: string, drag: () => void) => (
      <Pressable
        onLongPress={drag}
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
      // Web-only remount on order change (see orderKey above). Native does
      // not need it: the gesture system does not hold the stale autoscroll
      // state, and remounting would needlessly drop scroll position.
      key={Platform.OS === 'web' ? orderKey : undefined}
      style={styles.list}
      // Bounds the OUTER wrapper to the remaining viewport space: without
      // this the inner ScrollView grows to its full content height on web and
      // the steps below the fold become unreachable (no scroll container is
      // ever created).
      containerStyle={styles.listContainer}
      onContainerLayout={onContainerLayout}
      contentContainerStyle={styles.listContent}
      ListHeaderComponent={ListHeaderComponent}
      renderItem={({ item, getIndex, drag, isActive }) => (
        <ChecklistRow index={getIndex() ?? 0} count={steps.length}>
          <StepRow
            title={item.title}
            subtitle={item.subtitle}
            done={item.done}
            custom={item.custom}
            sideTag={sideTag}
            upNext={item.id === upNextId}
            active={isActive}
            onToggle={() => onToggle(item.id)}
            onDragStart={drag}
            dragHandle={renderGrip(item.title, drag)}
          />
        </ChecklistRow>
      )}
      onDragBegin={() => {
        dragActiveRef.current = true;
      }}
      onDragEnd={({ data }) => {
        dragActiveRef.current = false;
        // Preserve scroll across the order-change remount (see orderKey).
        if (Platform.OS === 'web') {
          const scroller = findScroller(containerElRef.current);
          if (scroller) pendingScrollRef.current = scroller.scrollTop;
        }
        onReorder(data.map((s) => s.id));
      }}
      ListFooterComponent={ListFooterComponent}
    />
  );
}

/**
 * Client read-only checklist: the same single ordered list — checked steps in
 * place, UP NEXT on the first remaining step — but rows are plain Views (no
 * tap targets), no drag grips, and custom steps render exactly like default
 * steps. No recency markers (removed per Anuraj's review, Sept 26).
 */
export function ReadOnlyChecklist({ steps }: { steps: StepT[] }) {
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
          />
        </ChecklistRow>
      ))}
    </Card>
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
});
