import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import DraggableFlatList from 'react-native-draggable-flatlist';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { store } from '../../src/lib/store-instance';
import type { ClientRole, Escrow, StepT } from '../../src/lib/types';
import { ProgressRing } from '../../src/components/ProgressRing';
import { TimeTrackerCard } from '../../src/components/TimeTrackerCard';
import { StepRow } from '../../src/components/StepRow';
import { Field, Grip, PrimaryButton, SecondaryButton } from '../../src/components/ui';
import { colors } from '../../src/theme';
import { partyLine } from '../index';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

export default function TransactionDetail() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = params.id;
  const escrowId = Array.isArray(rawId) ? rawId[0] : rawId;

  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const [dateFormOpen, setDateFormOpen] = useState(false);
  const [newCloseDate, setNewCloseDate] = useState('');
  const [dateError, setDateError] = useState<string | undefined>(undefined);

  // INTERIM (both-side tab UI is held pending designer review):
  // a both-side escrow renders the BUYER checklist only. The two lists stay independent.
  const role: ClientRole = escrow?.side === 'sell' ? 'seller' : 'buyer';

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

  const toggle = async (stepId: string) => {
    if (!escrow) return;
    try {
      setEscrow(await store.toggleStep(escrow.id, role, stepId));
    } catch (err) {
      console.warn('toggleStep failed', err);
    }
  };

  const addCustom = async () => {
    const title = newTitle.trim();
    if (!escrow || !title || saving) return;
    setSaving(true);
    try {
      setEscrow(await store.addCustomStep(escrow.id, role, title));
      setNewTitle('');
      setAdding(false);
    } catch (err) {
      console.warn('addCustomStep failed', err);
    } finally {
      setSaving(false);
    }
  };

  const closeEscrowNow = async () => {
    if (!escrow) return;
    try {
      await store.closeEscrow(escrow.id);
      router.back();
    } catch (err) {
      console.warn('closeEscrow failed', err);
    }
  };

  const saveTargetDate = async () => {
    if (!escrow || saving) return;
    if (!isRealDate(newCloseDate)) {
      setDateError('Use YYYY-MM-DD.');
      return;
    }
    setDateError(undefined);
    setSaving(true);
    try {
      setEscrow(await store.updateTargetDate(escrow.id, newCloseDate));
      setNewCloseDate('');
      setDateFormOpen(false);
    } catch (err) {
      console.warn('updateTargetDate failed', err);
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

  const raw = role === 'buyer' ? escrow.buyerSteps : escrow.sellerSteps;
  const steps: StepT[] = [...raw].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const done = steps.filter((s) => s.done).length;
  const allDone = steps.length > 0 && done === steps.length;

  return (
    <GestureHandlerRootView style={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <Text style={styles.backText}>‹ Escrows</Text>
        </Pressable>
        <View style={styles.titleRow}>
          <View style={styles.titleCol}>
            <Text style={styles.title} numberOfLines={2}>
              {escrow.address}
            </Text>
            <Text style={styles.subtitle}>{`${escrow.city} · ${partyLine(escrow)}`}</Text>
          </View>
          <View style={styles.ringCol}>
            <ProgressRing done={done} total={steps.length} size={72} />
            <Text style={styles.ringCap}>{`${done} of ${steps.length} steps`}</Text>
          </View>
        </View>
      </View>

      <DraggableFlatList
        data={steps}
        keyExtractor={(s) => s.id}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            <TimeTrackerCard
              openDate={escrow.openDate}
              closeDate={escrow.closeDate}
              onUpdateDate={() => {
                setNewCloseDate('');
                setDateError(undefined);
                setDateFormOpen(true);
              }}
            />
            <View style={styles.shareBtnWrap}>
              <SecondaryButton
                title="Share this escrow"
                onPress={() => router.push(`/share/${escrow.id}`)}
              />
            </View>
            {dateFormOpen && (
              <View style={styles.addForm}>
                <Field
                  label="New target close date"
                  value={newCloseDate}
                  onChangeText={(v) => {
                    setNewCloseDate(v);
                    setDateError(undefined);
                  }}
                  placeholder="YYYY-MM-DD"
                />
                {dateError ? <Text style={styles.error}>{dateError}</Text> : null}
                <View style={styles.addBtns}>
                  <View style={styles.addPrimary}>
                    <PrimaryButton
                      title={saving ? 'Saving…' : 'Save'}
                      onPress={saveTargetDate}
                      disabled={saving || !newCloseDate.trim()}
                    />
                  </View>
                  <Pressable
                    onPress={() => {
                      setDateFormOpen(false);
                      setNewCloseDate('');
                      setDateError(undefined);
                    }}
                    hitSlop={8}
                    style={styles.cancelBtn}
                  >
                    <Text style={styles.cancelText}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            )}
            {allDone && (
              <View style={styles.banner}>
                <Text style={styles.bannerTitle}>{`All ${steps.length} steps complete.`}</Text>
                <Text style={styles.bannerSub}>This escrow is ready to move to Closed.</Text>
                <View style={styles.bannerBtn}>
                  <SecondaryButton title="Close escrow" onPress={closeEscrowNow} />
                </View>
              </View>
            )}
          </View>
        }
        renderItem={({ item, drag }) => (
          <StepRow
            title={item.title}
            subtitle={item.subtitle}
            done={item.done}
            custom={item.custom}
            onToggle={() => toggle(item.id)}
            dragHandle={
              <Pressable onPressIn={drag} hitSlop={6} style={styles.gripHit}>
                <Grip />
              </Pressable>
            }
          />
        )}
        onDragEnd={async ({ data }) => {
          try {
            setEscrow(await store.reorderSteps(escrow.id, role, data.map((s) => s.id)));
          } catch (err) {
            console.warn('reorderSteps failed', err);
          }
        }}
        ListFooterComponent={
          <View>
            {adding ? (
              <View style={styles.addForm}>
                <Field
                  label="Custom step"
                  value={newTitle}
                  onChangeText={setNewTitle}
                  placeholder="e.g. Termite inspection report"
                />
                <View style={styles.addBtns}>
                  <View style={styles.addPrimary}>
                    <PrimaryButton
                      title={saving ? 'Adding…' : 'Add step'}
                      onPress={addCustom}
                      disabled={saving || !newTitle.trim()}
                    />
                  </View>
                  <Pressable
                    onPress={() => {
                      setAdding(false);
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
              <Pressable onPress={() => setAdding(true)} style={styles.addDashed}>
                <Text style={styles.addDashedText}>+ Add a custom step</Text>
              </Pressable>
            )}
            <Text style={styles.footnote}>
              {'Tap a step to check it off. Tap again to undo.\nDrag the grip to reorder.'}
            </Text>
          </View>
        }
      />
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
  list: {
    flex: 1,
  },
  listContent: {
    padding: 18,
    paddingTop: 4,
    paddingBottom: 36,
  },
  shareBtnWrap: {
    marginTop: 14,
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
  gripHit: {
    padding: 8,
    justifyContent: 'center',
  },
  addDashed: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: colors.line,
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
  error: {
    fontSize: 13,
    color: colors.red,
    marginTop: 6,
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
