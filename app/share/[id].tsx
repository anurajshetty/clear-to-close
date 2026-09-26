// Clear to Close — per-escrow invite management.
// Faithful to APPROVED mockup 01 · Escrow tracker v1, device ⑨.
import React, { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { store } from '../../src/lib/store-instance';
import { partyLine } from '../index';
import type { ClientRole, Escrow, Invite } from '../../src/lib/types';
import { ProgressRing } from '../../src/components/ProgressRing';
import { TimeTrackerCard } from '../../src/components/TimeTrackerCard';
import { InviteSheet } from '../../src/components/InviteSheet';
import { Card, Kicker, SecondaryButton } from '../../src/components/ui';
import { colors, radius } from '../../src/theme';

interface SideMeta {
  role: ClientRole;
  label: string; // "Buyer" | "Seller"
  noun: string; // "buyer" | "seller"
}

function sidesFor(side: Escrow['side']): SideMeta[] {
  if (side === 'sell') return [{ role: 'seller', label: 'Seller', noun: 'seller' }];
  if (side === 'buy') return [{ role: 'buyer', label: 'Buyer', noun: 'buyer' }];
  return [
    { role: 'buyer', label: 'Buyer', noun: 'buyer' },
    { role: 'seller', label: 'Seller', noun: 'seller' },
  ];
}

function countDone(steps: { done: boolean }[]): number {
  return steps.reduce((n, s) => n + (s.done ? 1 : 0), 0);
}

// Progress ring for the header: buyer role for buy, seller for sell, combined for both.
function headerProgress(escrow: Escrow): { done: number; total: number } {
  const buyerSteps = escrow.buyerSteps;
  const sellerSteps = escrow.sellerSteps;
  if (escrow.side === 'both') {
    return {
      done: countDone(buyerSteps) + countDone(sellerSteps),
      total: buyerSteps.length + sellerSteps.length,
    };
  }
  const steps = escrow.side === 'sell' ? sellerSteps : buyerSteps;
  return { done: countDone(steps), total: steps.length };
}

// Latest invite per side that can still be redeemed.
function latestActive(invites: Invite[], role: ClientRole): Invite | null {
  const mine = invites
    .filter((i) => i.role === role && !i.redeemedAt && !i.revokedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return mine[0] ?? null;
}

export default function ShareEscrow() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = params.id;
  const escrowId = Array.isArray(rawId) ? rawId[0] : rawId;

  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sheetSide, setSheetSide] = useState<ClientRole | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  };

  const refreshInvites = useCallback(async () => {
    if (!escrowId) return;
    try {
      setInvites(await store.listInvites(escrowId));
    } catch (err) {
      console.warn('listInvites failed', err);
    }
  }, [escrowId]);

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
  }, [escrowId, refreshInvites]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const copyCode = async (code: string) => {
    try {
      await Clipboard.setStringAsync(code);
    } catch (err) {
      console.warn('clipboard failed', err);
    }
    showToast('Copied.');
  };

  const doRevoke = async () => {
    if (!revokeId) return;
    try {
      await store.revokeInvite(revokeId);
      showToast('Invite removed.');
      await refreshInvites();
    } catch (err) {
      console.warn('revokeInvite failed', err);
    } finally {
      setRevokeId(null);
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

  const sides = sidesFor(escrow.side);
  const progress = headerProgress(escrow);

  return (
    <View style={styles.screen}>
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
            <ProgressRing done={progress.done} total={progress.total} size={72} />
            <Text style={styles.ringCap}>{`${progress.done} of ${progress.total} steps`}</Text>
          </View>
        </View>
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
      >
        <TimeTrackerCard openDate={escrow.openDate} closeDate={escrow.closeDate} />

        <Card style={styles.shareCard}>
          <View style={styles.kickWrap}>
            <Kicker>Share this escrow</Kicker>
          </View>

          {sides.map((s) => {
            const active = latestActive(invites, s.role);
            return (
              <View key={s.role} style={styles.sideBlock}>
                {active ? (
                  <View style={styles.invRow}>
                    <View style={styles.invCol}>
                      <Text style={styles.invLabel}>{s.label} invite</Text>
                      <Text style={styles.invName}>{`${active.partyName} · Invited`}</Text>
                      <Text style={styles.invCode}>{active.code}</Text>
                    </View>
                    <View style={styles.invActions}>
                      <Pressable
                        onPress={() => copyCode(active.code)}
                        hitSlop={8}
                        style={styles.copyBtn}
                      >
                        <Text style={styles.copyText}>Copy</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => setRevokeId(active.id)}
                        hitSlop={8}
                        style={styles.xBtn}
                      >
                        <Text style={styles.xText}>×</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <SecondaryButton
                    title={`Invite the ${s.noun}`}
                    onPress={() => setSheetSide(s.role)}
                  />
                )}
              </View>
            );
          })}

          {revokeId && (
            <View style={styles.revokeBox}>
              <Text style={styles.revokeTitle}>Remove invite?</Text>
              <Text style={styles.revokeText}>
                The invite and its code stop working. You can send them a fresh one
                anytime.
              </Text>
              <View style={styles.revokeBtns}>
                <View style={styles.revokePrimary}>
                  <Pressable onPress={doRevoke} style={styles.removeBtn}>
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                </View>
                <Pressable
                  onPress={() => setRevokeId(null)}
                  hitSlop={8}
                  style={styles.keepBtn}
                >
                  <Text style={styles.keepText}>Keep</Text>
                </Pressable>
              </View>
            </View>
          )}

          <Text style={styles.hint}>
            Buyer and seller each get their own code for this escrow — one invite per
            side.
          </Text>
        </Card>
      </ScrollView>

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

      {toastMsg && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMsg}</Text>
        </View>
      )}
    </View>
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
    paddingTop: 14,
    paddingBottom: 36,
  },
  shareCard: {
    marginTop: 14,
  },
  kickWrap: {
    marginBottom: 12,
  },
  sideBlock: {
    marginBottom: 10,
  },
  invRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  invCol: {
    flex: 1,
  },
  invLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.body,
  },
  invName: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 3,
  },
  invCode: {
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 3,
    color: colors.ink,
    marginTop: 4,
  },
  invActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  copyBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  copyText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  xBtn: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  xText: {
    color: colors.muted,
    fontSize: 22,
    fontWeight: '400',
  },
  revokeBox: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 16,
    marginTop: 4,
  },
  revokeTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
  },
  revokeText: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.body,
    marginTop: 6,
  },
  revokeBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  revokePrimary: {
    flex: 1,
  },
  removeBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    backgroundColor: colors.red,
    borderRadius: radius.button,
  },
  removeText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  keepBtn: {
    minHeight: 52,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  keepText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
    marginTop: 12,
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
});
