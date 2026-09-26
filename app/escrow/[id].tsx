// Clear to Close — realtor transaction detail.
// Faithful to APPROVED mockup 01 · devices 2/3 (single-side) and 12 (both-side):
// one single checklist in the realtor's order — no Completed/Remaining
// grouping, no continuous full-height spine (only short connectors between
// consecutive circles). Editable: tap check/uncheck in place, drag grips on
// all rows, "+ Add a custom step", Custom tag on custom steps, UP NEXT on the
// first remaining step, ring recounts against the current total.
// Both-side escrows (dual agency): shared time-tracker card on top, then a
// Buyer | Seller tab switcher — each tab fully independent (own checklist,
// ring, add-step; rows carry a Buyer/Seller tag). No shared-step syncing.
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { store } from '../../src/lib/store-instance';
import type { ClientRole, Escrow, Invite, StepT } from '../../src/lib/types';
import { ProgressRing } from '../../src/components/ProgressRing';
import { TimeTrackerCard } from '../../src/components/TimeTrackerCard';
import { EditableChecklist } from '../../src/components/Checklist';
import { InviteSheet } from '../../src/components/InviteSheet';
import { ClientList } from '../../src/components/ClientList';
import { Field, Kicker, PrimaryButton, SecondaryButton } from '../../src/components/ui';
import { closedDisplayDate, formatClosedDate, sideClosedAt } from '../../src/lib/lifecycle';
import { colors } from '../../src/theme';
import { partyLine } from '../index';

function sortedSteps(raw: StepT[]): StepT[] {
  return [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export default function TransactionDetail() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = params.id;
  const escrowId = Array.isArray(rawId) ? rawId[0] : rawId;

  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState<ClientRole | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [saving, setSaving] = useState(false);
  // Both-side tab state (mockup 01 · device 12).
  const [tab, setTab] = useState<ClientRole>('buyer');
  // Invite-client flow (approved Sept 2026): per-side invites live at the end
  // of the checklist page/tab.
  const [invites, setInvites] = useState<Invite[]>([]);
  const [sheetSide, setSheetSide] = useState<ClientRole | null>(null);
  const [clientSide, setClientSide] = useState<ClientRole | null>(null);

  const refreshInvites = useCallback(async () => {
    if (!escrowId) return;
    try {
      setInvites(await store.listInvites(escrowId));
    } catch (err) {
      console.warn('listInvites failed', err);
    }
  }, [escrowId]);

  const both = escrow?.side === 'both';
  const role: ClientRole = both ? tab : escrow?.side === 'sell' ? 'seller' : 'buyer';

  const refresh = useCallback(async () => {
    if (!escrowId) return;
    try {
      setEscrow(await store.getEscrow(escrowId));
      await refreshInvites();
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
    try {
      setEscrow(await store.toggleStep(escrow.id, r, stepId));
    } catch (err) {
      console.warn('toggleStep failed', err);
    }
  };

  const reorder = async (r: ClientRole, orderedIds: string[]) => {
    if (!escrow) return;
    try {
      setEscrow(await store.reorderSteps(escrow.id, r, orderedIds));
    } catch (err) {
      console.warn('reorderSteps failed', err);
    }
  };

  const addCustom = async (r: ClientRole) => {
    const title = newTitle.trim();
    if (!escrow || !title || saving) return;
    setSaving(true);
    try {
      setEscrow(await store.addCustomStep(escrow.id, r, title));
      setNewTitle('');
      setAdding(null);
    } catch (err) {
      console.warn('addCustomStep failed', err);
    } finally {
      setSaving(false);
    }
  };

  const closeEscrowNow = async (r: ClientRole) => {
    if (!escrow || saving) return;
    setSaving(true);
    try {
      // Per-side close (dual agency closes independently). Stay on the page
      // so the "Closed" indicator renders in place of the banner.
      setEscrow(await store.closeEscrow(escrow.id, r));
    } catch (err) {
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

  // "Invite client" → "View clients" at the end of the checklist (approved
  // invite-client flow, Sept 2026). Present on buy, sell, and each dual-
  // agency tab; flips to "View clients" once an active invite exists.
  const renderInviteButton = (r: ClientRole) => {
    const count = invites.filter((i) => i.role === r && !i.revokedAt).length;
    return (
      <View style={styles.inviteBtnWrap}>
        <SecondaryButton
          title={count > 0 ? 'View clients' : 'Invite client'}
          onPress={() => (count > 0 ? setClientSide(r) : setSheetSide(r))}
        />
      </View>
    );
  };

  // "+ Add a custom step" dashed button + inline form (mockup 01 · .addstep).
  // Rendered per list (single-side) or per tab (both-side).
  const renderAddStep = (r: ClientRole) =>
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
            <PrimaryButton
              title={saving ? 'Adding…' : 'Add step'}
              onPress={() => addCustom(r)}
              disabled={saving || !newTitle.trim()}
            />
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

  const renderTabPanel = (r: ClientRole) => {
    const steps = stepsFor(r);
    const done = steps.filter((s) => s.done).length;
    return (
      <>
        <View style={styles.tabHead}>
          <View style={styles.tabRing}>
            <ProgressRing done={done} total={steps.length} size={72} />
            <Text style={styles.ringCap}>{`${done} of ${steps.length} steps`}</Text>
          </View>
          <View>
            <Kicker>{r === 'buyer' ? 'Buyer checklist' : 'Seller checklist'}</Kicker>
            <Text style={styles.tabCap}>Checked off independently</Text>
          </View>
        </View>
        {renderLifecycle(r)}
        <EditableChecklist
          steps={steps}
          sideTag={r === 'buyer' ? 'Buyer' : 'Seller'}
          onToggle={(id) => toggle(r, id)}
          onReorder={(ids) => reorder(r, ids)}
          ListFooterComponent={
            <View>
              {renderAddStep(r)}
              <Text style={styles.footnote}>
                {'Tap the circle to check a step off. Tap it again to undo.\nPress and hold any step to reorder the list.'}
              </Text>
              {renderInviteButton(r)}
            </View>
          }
        />
      </>
    );
  };

  const singleSteps = stepsFor(role);
  const singleDone = singleSteps.filter((s) => s.done).length;

  return (
    <GestureHandlerRootView style={styles.screen}>
      <View style={styles.header}>
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

      {both ? (
        // Dual agency (mockup 01 · device 12): the shared time-tracker card
        // sits above the tabs; each tab is its own independent checklist.
        <View style={styles.bothWrap}>
          <View style={styles.bothTop}>
            <TimeTrackerCard
              openDate={escrow.openDate}
              closeDate={escrow.closeDate}
            />
            {/* Reorder hint in the removed "Share this escrow" spot (Sept
                2026): quiet line, realtor view only — client checklists are
                read-only and live on separate screens. */}
            <Text style={styles.reorderHint} testID="reorder-hint">
              Long-press any checklist item to reorder it.
            </Text>
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
        <EditableChecklist
          steps={singleSteps}
          onToggle={(id) => toggle(role, id)}
          onReorder={(ids) => reorder(role, ids)}
          ListHeaderComponent={
            <View>
              <TimeTrackerCard
                openDate={escrow.openDate}
                closeDate={escrow.closeDate}
              />
              {/* Reorder hint in the removed "Share this escrow" spot (Sept
                  2026): quiet line, realtor view only. */}
              <Text style={styles.reorderHint} testID="reorder-hint">
                Long-press any checklist item to reorder it.
              </Text>
              {renderLifecycle(role)}
            </View>
          }
          ListFooterComponent={
            <View>
              {renderAddStep(role)}
              <Text style={styles.footnote}>
                {'Tap the circle to check a step off. Tap it again to undo.\nPress and hold any step to reorder the list.'}
              </Text>
              {renderInviteButton(role)}
            </View>
          }
        />
      )}
      {sheetSide && (
        <InviteSheet
          visible
          side={sheetSide}
          address={escrow.address}
          escrowId={escrow.id}
          onClose={() => setSheetSide(null)}
          onCreated={refreshInvites}
        />
      )}
      {clientSide && (
        <ClientList
          visible
          side={clientSide}
          address={escrow.address}
          escrowId={escrow.id}
          onClose={() => {
            setClientSide(null);
            refreshInvites();
          }}
        />
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
  // Quiet reorder hint in the removed "Share this escrow" spot: same
  // type/color tokens as the footnote, tighter spacing to sit between the
  // time-tracker card and the checklist.
  reorderHint: {
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 14,
  },
  inviteBtnWrap: {
    marginTop: 14,
  },
  error: {
    fontSize: 13,
    color: colors.red,
    marginTop: 6,
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
  tabHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 24,
    paddingTop: 14,
    paddingBottom: 2,
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
