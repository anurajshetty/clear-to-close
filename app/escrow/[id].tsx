// Clear to Close — realtor transaction detail.
// Faithful to APPROVED mockup 01 · devices 2/3 (single-side) and 12 (both-side):
// one single checklist in the realtor's order — no Completed/Remaining
// grouping, no continuous full-height spine (only short connectors between
// consecutive circles). View mode: tap check/uncheck in place, Custom tag on
// custom steps, UP NEXT on the first remaining step, ring recounts against
// the current total. Edit mode (pencil, Sept 2026): the header swaps to a
// muted discard X (left) and a teal tick (right); rows are inert, every row
// shows a red remove button and an end-of-row drag grip; "+ Add a custom
// step" is a sticky pinned footer; the tick saves the whole draft with one
// server-confirmed write. Both-side escrows (dual agency): shared
// time-tracker card on top, then a Buyer | Seller tab switcher — each tab
// fully independent (own checklist, ring, edit draft; rows carry a
// Buyer/Seller tag). No shared-step syncing.
import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Svg, { Path } from 'react-native-svg';
import { store } from '../../src/lib/store-instance';
import type { ChecklistDraftStep, ClientRole, Escrow, StepT } from '../../src/lib/types';
import { uid } from '../../src/lib/store';
import { ProgressRing } from '../../src/components/ProgressRing';
import { TimeTrackerCard } from '../../src/components/TimeTrackerCard';
import { TcEntryCard } from '../../src/components/TcIntakeEntry';
import { describeTcIntakeStatus, showTcIntakeForRealtorSide } from '../../src/lib/tcIntake';
import { EditableChecklist } from '../../src/components/Checklist';
import { Field, Kicker, PrimaryButton, SecondaryButton, useKeyboardHeight } from '../../src/components/ui';
import { closedDisplayDate, formatClosedDate, sideClosedAt } from '../../src/lib/lifecycle';
import { colors } from '../../src/theme';
import { partyLine } from '../index';

// Material "edit" (pencil) and "close" (X) paths, 24x24 viewBox — the same
// glyphs as the deal cards, so the icons render identically on iOS and web
// with no native module.
const PENCIL_PATH =
  'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';
const X_PATH =
  'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

function sortedSteps(raw: StepT[]): StepT[] {
  return [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/**
 * TC intake entry row (Sept 29, 2026, mockup 04 device 1): directly below
 * the time-tracker card on listing-side escrows only — seller-only escrows
 * always, dual-agency escrows on the seller tab only, buyer-only escrows
 * never. "Not started" + chevron until anything is saved, then
 * "X of Y filled"/"Complete" + the pencil-once-saved. Tapping always
 * opens the editable form (read-only on closed/cancelled escrows).
 */
function TcIntakeEntryRow({
  escrowId,
  side,
  tab,
}: {
  escrowId: string;
  side: 'buy' | 'sell' | 'both';
  tab: ClientRole;
}) {
  const rowRouter = useRouter();
  const [status, setStatus] = useState(describeTcIntakeStatus(null));
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      (async () => {
        // Server is the source of truth: pure pull first (never throws),
        // then read the converged cache for the status line.
        await store.refreshTcIntake(escrowId);
        const row = await store.getTcIntake(escrowId);
        if (!cancelled) setStatus(describeTcIntakeStatus(row ? row.data : null));
      })();
      return () => {
        cancelled = true;
      };
    }, [escrowId]),
  );
  if (!showTcIntakeForRealtorSide(side, tab === 'seller' ? 'seller' : 'buyer')) return null;
  return (
    <TcEntryCard
      title="TC intake"
      caption={status.text}
      icon="clipboard"
      trailing={status.started ? 'pencil' : 'chevron'}
      onPress={() => rowRouter.push(`/tc-intake/${escrowId}`)}
      accessibilityLabel={`TC intake. ${status.text}.`}
      accessibilityHint="Opens the editable TC intake form for the listing."
      testID="tc-intake-entry"
    />
  );
}

export default function TransactionDetail() {
  const router = useRouter();
  // iOS (Sept 2026): the back button rendered under the status bar and was
  // effectively untappable. Clear the safe-area inset plus a deliberate gap
  // (the existing 14) so the whole header sits below the notch.
  const insets = useSafeAreaInsets();
  // Keyboard avoidance (Sept 28, 2026, Anuraj: every input stays visible
  // above the keyboard). The shared pattern: lift the screen by the keyboard
  // height. The edit-mode add form lives in the sticky pinned footer, so it
  // is always visible — no scroll-into-view needed.
  const kbHeight = useKeyboardHeight();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = params.id;
  const escrowId = Array.isArray(rawId) ? rawId[0] : rawId;

  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState<ClientRole | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [saving, setSaving] = useState(false);
  // Synchronous writes (Anuraj, Sept 28, 2026): every checklist/lifecycle
  // write waits for server confirmation and throws on failure instead of
  // applying locally. The failure must be visible on screen — this single
  // error line (the screen's existing error style) carries it. Cleared on
  // the next write attempt.
  const [writeError, setWriteError] = useState<string | null>(null);
  const writeErrorCopy = (err: unknown): string =>
    err instanceof Error && err.message
      ? err.message
      : "Couldn't save. Check your connection and try again.";
  // Both-side tab state (mockup 01 · device 12).
  const [tab, setTab] = useState<ClientRole>('buyer');
  // Checklist edit mode (Sept 2026): which side is being edited and its
  // in-progress draft. The draft is the ONLY thing an edit mutates —
  // nothing is written until the tick saves it with one server-confirmed
  // write. Dual-agency tabs hold independent drafts (editingRole picks the
  // side); editing one tab never touches the other.
  const [editingRole, setEditingRole] = useState<ClientRole | null>(null);
  const [draft, setDraft] = useState<ChecklistDraftStep[] | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Toast (same pattern as the deal list): sits above the scroll view so it
  // never scrolls away.
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  };
  // Share flow (Anuraj's final decision, Sept 29, 2026): the single
  // "Share this escrow" button below pushes the full-screen Share route.
  // Per-side invite state now lives on that screen, not here.

  const both = escrow?.side === 'both';
  const role: ClientRole = both ? tab : escrow?.side === 'sell' ? 'seller' : 'buyer';

  const refresh = useCallback(async () => {
    if (!escrowId) return;
    try {
      setEscrow(await store.getEscrow(escrowId));
    } catch (err) {
      console.warn('getEscrow failed', err);
    } finally {
      setLoaded(true);
    }
  }, [escrowId]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const toggle = async (r: ClientRole, stepId: string) => {
    if (!escrow) return;
    setWriteError(null);
    try {
      setEscrow(await store.toggleStep(escrow.id, r, stepId));
    } catch (err) {
      setWriteError(writeErrorCopy(err));
      console.warn('toggleStep failed', err);
    }
  };

  // ---- Checklist edit mode: draft operations (nothing is written) ----

  const startEditing = (r: ClientRole) => {
    if (!escrow || editingRole !== null) return;
    const steps = r === 'buyer' ? escrow.buyerSteps : escrow.sellerSteps;
    setDraft(
      sortedSteps(steps).map((s) => ({
        id: s.id,
        title: s.title,
        subtitle: s.subtitle,
        done: s.done,
        custom: s.custom,
        completedAt: s.completedAt,
        // (Sept 30, 2026): carry the template identity so key dates show
        // on matching steps while editing, not just after save.
        templateKey: s.templateKey,
      })),
    );
    setSaveError(null);
    setAdding(null);
    setNewTitle('');
    setEditingRole(r);
  };

  const discardEdit = () => {
    setEditingRole(null);
    setDraft(null);
    setAdding(null);
    setNewTitle('');
    setSaveError(null);
  };

  const removeDraftStep = (stepId: string) => {
    setDraft((d) => (d ? d.filter((s) => s.id !== stepId) : d));
  };

  const reorderDraft = (orderedIds: string[]) => {
    setDraft((d) => {
      if (!d) return d;
      const byId = new Map(d.map((s) => [s.id, s]));
      return orderedIds.map((id) => byId.get(id)).filter((s): s is ChecklistDraftStep => !!s);
    });
  };

  const addToDraft = (r: ClientRole) => {
    const title = newTitle.trim();
    if (!title || editingRole !== r) return;
    // The client-generated id survives a save retry: unknown ids are
    // treated as new steps and keep the given id, so the server upsert
    // stays idempotent (no duplicate steps on retry).
    setDraft((d) => [
      ...(d ?? []),
      { id: uid(), title, subtitle: '', done: false, custom: true, completedAt: null },
    ]);
    setNewTitle('');
    setAdding(null);
  };

  // The tick: save the whole draft with one server-confirmed write. The
  // local state updates only after the server confirms; a failure keeps
  // the draft in place for retry and shows a plain-language error.
  const saveEdit = async () => {
    if (!escrow || editingRole === null || !draft || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Edit mode saves through the real synchronous confirmed write:
      // preview -> server (pushEscrowNow + deleteStepRowsNow) -> commit.
      // Local state changes only after the server confirms; a failure
      // keeps the draft in place for retry with a plain-language error.
      const saved = await store.applyChecklistEdits(escrow.id, editingRole, draft);
      setEscrow(saved);
      setEditingRole(null);
      setDraft(null);
      setAdding(null);
      setNewTitle('');
      showToast('Checklist updated.');
    } catch (err) {
      setSaveError(
        err instanceof Error && err.message
          ? err.message
          : 'Could not save the checklist. Check your connection and try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const closeEscrowNow = async (r: ClientRole) => {
    if (!escrow || saving) return;
    setSaving(true);
    setWriteError(null);
    try {
      // Per-side close (dual agency closes independently). Stay on the page
      // so the "Closed" indicator renders in place of the banner. Closing
      // kills the clients' device links for the closed side (and the TC's
      // once the whole escrow is closed) — they land on the dead-link
      // screen ("this code no longer works").
      setEscrow((await store.closeEscrow(escrow.id, r)).escrow);
    } catch (err) {
      setWriteError(writeErrorCopy(err));
      console.warn('closeEscrow failed', err);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>Loading…</Text>
      </View>
    );
  }

  if (!escrow) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>Escrow not found</Text>
        <View style={styles.centerBtn}>
          <SecondaryButton title="Back to escrows" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  const stepsFor = (r: ClientRole): StepT[] =>
    sortedSteps(r === 'buyer' ? escrow.buyerSteps : escrow.sellerSteps);

  const subtitle = both ? `${escrow.city} · Dual agency` : `${escrow.city} · ${partyLine(escrow)}`;

  // Escrow lifecycle (approved Sept 2026): the all-steps-complete sage
  // banner carries the close button — once closed it becomes the "Closed"
  // indicator (sage tag + "Closed {date}.", no button). Unchecking any step
  // in a closed side moves that side back to Active (store-level), so the
  // banner returns when re-completed.
  const renderLifecycle = (r: ClientRole) => {
    if (!escrow) return null;
    const closedAt = sideClosedAt(escrow, r);
    // Legacy rows closed before per-side dates existed carry status='closed'
    // with no side dates — render the indicator without a date.
    const legacyClosed =
      escrow.status === 'closed' && closedDisplayDate(escrow) === null;
    if (closedAt !== null || legacyClosed) {
      return (
        <View style={styles.closedInd} testID={`closed-indicator-${r}`}>
          <View style={styles.closedTag}>
            <Text style={styles.closedTagText}>Closed</Text>
          </View>
          <Text style={styles.closedDate}>
            {closedAt ? `Closed ${formatClosedDate(closedAt)}.` : 'Closed.'}
          </Text>
          <Text style={styles.closedNote}>
            {both
              ? r === 'buyer'
                ? 'The buyer side is closed. The seller side stays active. Uncheck any step to move this side back to Active.'
                : 'The seller side is closed. The buyer side stays active. Uncheck any step to move this side back to Active.'
              : 'This escrow sits under Closed escrows on the deal list. Uncheck any step to move it back to Active.'}
          </Text>
        </View>
      );
    }
    const steps = stepsFor(r);
    const done = steps.filter((s) => s.done).length;
    if (steps.length === 0 || done !== steps.length) return null;
    return (
      <View style={styles.banner} testID={`close-escrow-banner-${r}`}>
        <Text style={styles.bannerTitle}>{`All ${steps.length} steps complete.`}</Text>
        <Text style={styles.bannerSub}>
          {both ? 'This side is ready to move to Closed.' : 'This escrow is ready to move to Closed.'}
        </Text>
        <View style={styles.bannerBtn}>
          <SecondaryButton
            title={both ? (r === 'buyer' ? 'Close buyer side' : 'Close seller side') : 'Close escrow'}
            onPress={() => closeEscrowNow(r)}
          />
        </View>
      </View>
    );
  };

  // "Share this escrow" at the end of the checklist (Anuraj's final
  // decision, Sept 29, 2026): ONE entry button replaces the three
  // per-side/TC "Invite client"/"View clients"/"Invite TC"/"View TC"
  // buttons. It pushes the full-screen Share route for this escrow and
  // stays visible on open, closed, and cancelled escrows alike — the
  // Share screen itself gates invite creation on dead escrows.
  const renderShareButton = () => {
    if (!escrow) return null;
    return (
      <View style={styles.inviteBtnWrap}>
        <SecondaryButton
          title="Share this escrow"
          onPress={() => router.push(`/share/${escrow.id}`)}
        />
      </View>
    );
  };

  // "+ Add a custom step" dashed button + inline form (mockup 01 · .addstep).
  // Edit mode only: it lives in the sticky pinned footer and appends to the
  // draft — nothing is written until the tick saves.
  const renderEditAddStep = (r: ClientRole) =>
    adding === r ? (
      <View style={styles.addForm}>
        <Field
          label="Custom step"
          value={newTitle}
          onChangeText={(t) => setNewTitle(t.slice(0, 60))}
          placeholder="Step name"
        />
        <View style={styles.addBtns}>
          <View style={styles.addPrimary}>
            <PrimaryButton title="Add step" onPress={() => addToDraft(r)} disabled={!newTitle.trim()} />
          </View>
          <Pressable
            onPress={() => {
              setAdding(null);
              setNewTitle('');
            }}
            hitSlop={8}
            style={styles.cancelBtn}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    ) : (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Add a custom step to the ${r} checklist`}
        testID={`checklist-add-${r}`}
        onPress={() => {
          setAdding(r);
          setNewTitle('');
        }}
        style={styles.addDashed}
      >
        <Text style={styles.addDashedText}>
          <Text style={styles.addPlus}>+ </Text>Add a custom step
        </Text>
      </Pressable>
    );

  // Checklist header (checklist edit mode, Sept 2026). View mode: the
  // CHECKLIST kicker and a muted 44pt pencil at the top-right. Edit mode:
  // the header swaps to a muted discard X on the left and the teal tick in
  // the pencil's exact spot on the right.
  const renderChecklistHead = (r: ClientRole) => {
    const isEditing = editingRole === r;
    return (
      <View style={styles.checkHead}>
        {isEditing ? (
          <>
            <Pressable
              onPress={discardEdit}
              accessibilityRole="button"
              accessibilityLabel="Discard checklist changes"
              testID={`checklist-discard-${r}`}
              hitSlop={8}
              style={styles.headBtn}
            >
              <Svg width={20} height={20} viewBox="0 0 24 24" aria-hidden={true}>
                <Path d={X_PATH} fill={colors.muted} />
              </Svg>
            </Pressable>
            <View style={styles.checkHeadCenter}>
              <Kicker>Checklist · Editing</Kicker>
            </View>
            <Pressable
              onPress={saveEdit}
              disabled={saving}
              accessibilityRole="button"
              accessibilityLabel="Save checklist changes"
              testID={`checklist-save-${r}`}
              hitSlop={8}
              style={[styles.headBtn, saving && { opacity: 0.5 }]}
            >
              <Text style={styles.checkTick}>✓</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Kicker>{both ? (r === 'buyer' ? 'Buyer checklist' : 'Seller checklist') : 'Checklist'}</Kicker>
            <Pressable
              onPress={() => startEditing(r)}
              accessibilityRole="button"
              accessibilityLabel={`Edit the ${r} checklist`}
              testID={`checklist-edit-${r}`}
              hitSlop={8}
              style={styles.headBtn}
            >
              <Svg width={20} height={20} viewBox="0 0 24 24" aria-hidden={true}>
                <Path d={PENCIL_PATH} fill={colors.muted} />
              </Svg>
            </Pressable>
          </>
        )}
      </View>
    );
  };

  // Sticky pinned footer (edit mode only): the add-step button/form stays
  // visible while the list scrolls, plus the quiet reorder hint and the
  // save-error line (the draft is kept for retry).
  const renderStickyAdd = (r: ClientRole) => (
    <View style={styles.stickyAdd}>
      {saveError ? (
        <Text style={styles.error} testID={`checklist-save-error-${r}`}>
          {saveError}
        </Text>
      ) : null}
      {renderEditAddStep(r)}
      <Text style={styles.hintLine}>Long-press an item to reorder.</Text>
    </View>
  );

  const renderTabPanel = (r: ClientRole) => {
    const steps = stepsFor(r);
    const done = steps.filter((s) => s.done).length;
    const isEditing = editingRole === r;
    // In edit mode the list renders the draft (the only thing the edit
    // mutates); the ring keeps showing the last saved counts until the tick.
    const listSteps: StepT[] =
      isEditing && draft
        ? draft.map((d, index) => ({
            id: d.id ?? `draft-${index}`,
            title: d.title,
            subtitle: d.subtitle ?? '',
            done: d.done,
            custom: d.custom,
            order: index,
            completedAt: d.completedAt ?? null,
            templateKey: d.templateKey,
          }))
        : steps;
    return (
      <View style={styles.tabPanelInner}>
        {isEditing ? (
          // Align with the list's 18px content padding (the tabHead uses a
          // wider 24px pad in view mode).
          <View style={styles.checkHeadPad}>{renderChecklistHead(r)}</View>
        ) : (
          <View style={styles.tabHead}>
            <View style={styles.tabRing}>
              <ProgressRing done={done} total={steps.length} size={72} />
              <Text style={styles.ringCap}>{`${done} of ${steps.length} steps`}</Text>
            </View>
            <View style={styles.tabHeadText}>
              <Kicker>{r === 'buyer' ? 'Buyer checklist' : 'Seller checklist'}</Kicker>
              <Text style={styles.tabCap}>Checked off independently</Text>
            </View>
            <Pressable
              onPress={() => startEditing(r)}
              accessibilityRole="button"
              accessibilityLabel={`Edit the ${r} checklist`}
              testID={`checklist-edit-${r}`}
              hitSlop={8}
              style={styles.headBtn}
            >
              <Svg width={20} height={20} viewBox="0 0 24 24" aria-hidden={true}>
                <Path d={PENCIL_PATH} fill={colors.muted} />
              </Svg>
            </Pressable>
          </View>
        )}
        {renderLifecycle(r)}
        <View style={styles.listWrap}>
          <EditableChecklist
            steps={listSteps}
            sideTag={r === 'buyer' ? 'Buyer' : 'Seller'}
            role={r}
            keyDates={{
              inspectionDeadline: escrow?.inspectionDeadline ?? null,
              appraisalDeadline: escrow?.appraisalDeadline ?? null,
              loanApprovalDate: escrow?.loanApprovalDate ?? null,
            }}
            editing={isEditing}
            onToggle={(id) => toggle(r, id)}
            onReorder={reorderDraft}
            onRemoveStep={removeDraftStep}
            ListFooterComponent={
              isEditing ? (
                // Spacer so the last row scrolls above the sticky footer.
                <View style={styles.stickySpacer} />
              ) : (
                <View>
                  <Text style={styles.footnote}>
                    {'Tap the circle to check a step off. Tap it again to undo.'}
                  </Text>
                  {renderShareButton()}
                </View>
              )
            }
          />
          {isEditing ? renderStickyAdd(r) : null}
        </View>
      </View>
    );
  };

  const singleSteps = stepsFor(role);
  const singleDone = singleSteps.filter((s) => s.done).length;

  return (
    <GestureHandlerRootView style={[styles.screen, { paddingBottom: kbHeight }]}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Back to escrows"
        >
          <Text style={styles.backText}>‹ Escrows</Text>
        </Pressable>
        <View style={styles.titleRow}>
          <View style={styles.titleCol}>
            <Text style={styles.title} numberOfLines={2}>
              {escrow.address}
            </Text>
            <Text style={styles.subtitle}>{subtitle}</Text>
          </View>
          {!both && (
            <View style={styles.ringCol}>
              <ProgressRing done={singleDone} total={singleSteps.length} size={72} />
              <Text style={styles.ringCap}>{`${singleDone} of ${singleSteps.length} steps`}</Text>
            </View>
          )}
        </View>
      </View>

      {/* Synchronous write failures (Sept 28, 2026): the write threw and
          local state is unchanged — the message says what to do next. */}
      {writeError && (
        <Text style={[styles.error, styles.writeErrorLine]} testID="write-error">
          {writeError}
        </Text>
      )}

      {both ? (
        // Dual agency (mockup 01 · device 12): the shared time-tracker card
        // sits above the tabs; each tab is its own independent checklist.
        <View style={styles.bothWrap}>
          <View style={styles.bothTop}>
            <TimeTrackerCard
              openDate={escrow.openDate}
              closeDate={escrow.closeDate}
            />
            <TcIntakeEntryRow escrowId={escrow.id} side={escrow.side} tab={tab} />
            <View
              style={styles.tabSwitch}
              accessibilityRole="tablist"
              accessibilityLabel="Transaction side"
            >
              {(['buyer', 'seller'] as ClientRole[]).map((r) => (
                <Pressable
                  key={r}
                  onPress={() => setTab(r)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: tab === r }}
                  accessibilityLabel={`${r === 'buyer' ? 'Buyer' : 'Seller'} checklist`}
                  style={[styles.tab, tab === r && styles.tabSelected]}
                >
                  <Text style={[styles.tabText, tab === r && styles.tabTextSelected]}>
                    {r === 'buyer' ? 'Buyer' : 'Seller'}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
          <View style={styles.tabPanel}>{renderTabPanel(tab)}</View>
        </View>
      ) : (
        <View style={styles.listWrap}>
          <EditableChecklist
            steps={
              editingRole === role && draft
                ? draft.map((d, index) => ({
                    id: d.id ?? `draft-${index}`,
                    title: d.title,
                    subtitle: d.subtitle ?? '',
                    done: d.done,
                    custom: d.custom,
                    order: index,
                    completedAt: d.completedAt ?? null,
                    templateKey: d.templateKey,
                  }))
                : singleSteps
            }
            role={role}
            keyDates={{
              inspectionDeadline: escrow?.inspectionDeadline ?? null,
              appraisalDeadline: escrow?.appraisalDeadline ?? null,
              loanApprovalDate: escrow?.loanApprovalDate ?? null,
            }}
            editing={editingRole === role}
            onToggle={(id) => toggle(role, id)}
            onReorder={reorderDraft}
            onRemoveStep={removeDraftStep}
            ListHeaderComponent={
              <View>
                <TimeTrackerCard
                  openDate={escrow.openDate}
                  closeDate={escrow.closeDate}
                />
                <TcIntakeEntryRow escrowId={escrow.id} side={escrow.side} tab={role} />
                {renderChecklistHead(role)}
                {renderLifecycle(role)}
              </View>
            }
            ListFooterComponent={
              editingRole === role ? (
                // Spacer so the last row scrolls above the sticky footer.
                <View style={styles.stickySpacer} />
              ) : (
                <View>
                  <Text style={styles.footnote}>
                    {'Tap the circle to check a step off. Tap it again to undo.'}
                  </Text>
                  {renderShareButton()}
                </View>
              )
            }
          />
          {editingRole === role ? renderStickyAdd(role) : null}
        </View>
      )}
      {/* Toast sits above the scroll view so it never scrolls away. */}
      {toastMsg && (
        <View style={styles.toast} testID="toast">
          <Text style={styles.toastText}>{toastMsg}</Text>
        </View>
      )}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  header: {
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 12,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  backBtn: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
    paddingRight: 12,
  },
  backText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  titleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 12,
    marginTop: 2,
  },
  titleCol: {
    flex: 1,
  },
  title: {
    fontSize: 21,
    fontWeight: '700',
    color: colors.ink,
  },
  subtitle: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 3,
  },
  ringCol: {
    alignItems: 'center',
    flexShrink: 0,
  },
  ringCap: {
    fontSize: 11.5,
    fontWeight: '700',
    color: colors.body,
    marginTop: 4,
    textAlign: 'center',
  },
  banner: {
    backgroundColor: colors.sageSoft,
    borderRadius: 14,
    padding: 16,
    marginTop: 14,
  },
  bannerTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
  },
  bannerSub: {
    fontSize: 13.5,
    color: colors.body,
    marginTop: 4,
  },
  bannerBtn: {
    marginTop: 12,
  },
  // "Closed" indicator (escrow lifecycle): sage tag + "Closed {date}.",
  // no button. Unchecking any step moves the side back to Active.
  closedInd: {
    backgroundColor: colors.sageSoft,
    borderRadius: 14,
    padding: 16,
    marginTop: 14,
  },
  closedTag: {
    alignSelf: 'flex-start',
    backgroundColor: '#E4EBDF',
    borderRadius: 8,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  closedTagText: {
    color: colors.sage,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  closedDate: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 10,
  },
  closedNote: {
    fontSize: 13.5,
    color: colors.body,
    marginTop: 4,
    lineHeight: 19,
  },
  addDashed: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.photoBorder,
    borderRadius: 14,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  addDashedText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  addPlus: {
    fontSize: 20,
  },
  addForm: {
    marginTop: 12,
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 14,
  },
  addBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
  },
  addPrimary: {
    flex: 1,
  },
  cancelBtn: {
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  cancelText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  footnote: {
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 18,
  },
  // Checklist header (checklist edit mode, Sept 2026): kicker + muted 44pt
  // pencil at the top-right in view mode; muted discard X on the left and
  // the teal tick in the pencil's exact spot on the right in edit mode.
  checkHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 16,
    minHeight: 44,
  },
  checkHeadCenter: {
    flex: 1,
    alignItems: 'center',
  },
  headBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkTick: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.accent,
  },
  // Sticky pinned footer (edit mode): the add-step button/form stays
  // visible while the list scrolls. Solid paper background + hairline top
  // border so scrolled rows slide under it.
  listWrap: {
    flex: 1,
  },
  stickyAdd: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.paper,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 14,
  },
  // Spacer at the end of the edit-mode list so the last row scrolls fully
  // above the sticky footer.
  stickySpacer: {
    height: 170,
  },
  // Quiet edit-mode hint under the sticky add button.
  hintLine: {
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 10,
  },
  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 40,
    backgroundColor: colors.ink,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  inviteBtnWrap: {
    marginTop: 14,
  },
  error: {
    fontSize: 13,
    color: colors.red,
    marginTop: 6,
  },
  // Synchronous write-failure line (Sept 28, 2026): aligns with the
  // screen's horizontal rhythm under the header.
  writeErrorLine: {
    paddingHorizontal: 18,
    marginBottom: 2,
  },
  // Both-side (dual agency) layout.
  bothWrap: {
    flex: 1,
  },
  bothTop: {
    paddingHorizontal: 18,
    paddingTop: 4,
  },
  tabSwitch: {
    flexDirection: 'row',
    backgroundColor: colors.tabBg,
    borderRadius: 14,
    padding: 4,
    marginTop: 14,
    marginBottom: 6,
  },
  tab: {
    flex: 1,
    borderRadius: 10,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  tabSelected: {
    backgroundColor: '#FFFFFF',
    shadowColor: '#1E190F',
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  tabText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.muted,
  },
  tabTextSelected: {
    color: colors.ink,
  },
  tabPanel: {
    flex: 1,
  },
  // Each tab's panel is a positioning context for the edit-mode sticky footer.
  tabPanelInner: {
    flex: 1,
  },
  tabHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 2,
  },
  tabHeadText: {
    flex: 1,
  },
  // Both-side edit header: match the list's 18px content padding.
  checkHeadPad: {
    paddingHorizontal: 18,
  },
  tabRing: {
    alignItems: 'center',
  },
  tabCap: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.body,
    marginTop: 3,
  },
  center: {
    flex: 1,
    backgroundColor: colors.paper,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  centerText: {
    fontSize: 15,
    color: colors.muted,
  },
  centerBtn: {
    marginTop: 18,
    alignSelf: 'stretch',
  },
});
