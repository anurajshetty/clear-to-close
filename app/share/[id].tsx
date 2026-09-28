// Clear to Close — per-escrow invite management.
// Faithful to APPROVED mockup 03 · onboarding/auth, device ⑳ (Regenerate code).
// Each client row shows the party name, link status (Linked to device /
// Invited), the code pill + Copy, and a "Regenerate code" action with a
// confirmation step. Regenerating atomically kills the old code and its
// device link and issues a fresh single-use code for the same escrow/role/party.
// The transaction coordinator (Sept 2026) gets the same treatment as a third
// party block: exactly one TC invite per escrow (cap of 1, enforced in the
// store and by the DB trigger), otherwise identical invite/code/regenerate
// logic.
import React, { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextStyle, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { store } from '../../src/lib/store-instance';
import { partyLine } from '../index';
import type { ClientLink, ClientRole, Escrow, Invite } from '../../src/lib/types';
import { ProgressRing } from '../../src/components/ProgressRing';
import { TimeTrackerCard } from '../../src/components/TimeTrackerCard';
import { InviteSheet } from '../../src/components/InviteSheet';
import { Card, Kicker, SecondaryButton } from '../../src/components/ui';
import { colors, radius } from '../../src/theme';

interface SideMeta {
  role: ClientRole;
  label: string; // "Buyer" | "Seller" | "Transaction coordinator"
  noun: string; // "buyer" | "seller" | "transaction coordinator"
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

// Latest non-revoked invite per side — redeemed ones stay visible so their
// code can be regenerated for the reinstall / new-device case.
function latestVisible(invites: Invite[], role: ClientRole): Invite | null {
  const mine = invites
    .filter((i) => i.role === role && !i.revokedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return mine[0] ?? null;
}

export default function ShareEscrow() {
  const router = useRouter();
  // iOS (Sept 2026): same notch crowding as the escrow header — clear the
  // safe-area inset plus a deliberate gap (the existing 14).
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = params.id;
  const escrowId = Array.isArray(rawId) ? rawId[0] : rawId;

  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [links, setLinks] = useState<Record<string, ClientLink | null>>({});
  const [loaded, setLoaded] = useState(false);
  const [sheetSide, setSheetSide] = useState<ClientRole | null>(null);
  const [regenConfirmId, setRegenConfirmId] = useState<string | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [lastRegen, setLastRegen] = useState<{
    inviteId: string;
    partyName: string;
    oldCode: string;
  } | null>(null);
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
      const list = await store.listInvites(escrowId);
      setInvites(list);
      const byId: Record<string, ClientLink | null> = {};
      await Promise.all(
        list.map(async (inv) => {
          try {
            byId[inv.id] = await store.getLinkForInvite(inv.id);
          } catch {
            byId[inv.id] = null;
          }
        }),
      );
      setLinks(byId);
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

  const doRegenerate = async () => {
    if (!regenConfirmId || regenBusy) return;
    const inv = invites.find((i) => i.id === regenConfirmId);
    if (!inv) {
      setRegenConfirmId(null);
      return;
    }
    setRegenBusy(true);
    try {
      const res = await store.regenerateInvite(inv.id);
      setLastRegen({ inviteId: res.invite.id, partyName: inv.partyName, oldCode: res.oldCode });
      showToast('New code created.');
      await refreshInvites();
    } catch (err) {
      console.warn('regenerateInvite failed', err);
      showToast('Could not create a new code. Try again.');
    } finally {
      setRegenBusy(false);
      setRegenConfirmId(null);
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
  // Transaction coordinator (Sept 2026): exactly one TC invite per escrow,
  // managed with the identical invite/code/regenerate logic as the sides.
  const tcMeta: SideMeta = {
    role: 'tc',
    label: 'Transaction coordinator',
    noun: 'transaction coordinator',
  };
  const regenInvite = regenConfirmId ? invites.find((i) => i.id === regenConfirmId) ?? null : null;
  const regenSide = regenInvite ? [...sides, tcMeta].find((s) => s.role === regenInvite.role) ?? null : null;

  // One invite-management block per party (buyer/seller side or TC): invite
  // button when empty, otherwise name + status + code pill + Copy +
  // Regenerate. The per-role cap (2 per side, 1 TC) is enforced in the store
  // and by the DB trigger, so no second block can ever appear.
  const renderPartyBlock = (s: SideMeta) => {
    const inv = latestVisible(invites, s.role);
    if (!inv) {
      return (
        <View key={s.role} style={styles.sideBlock}>
          <SecondaryButton
            title={`Invite the ${s.noun}`}
            onPress={() => setSheetSide(s.role)}
          />
        </View>
      );
    }
    const linked = !!links[inv.id];
    return (
      <View key={s.role} style={styles.sideBlock}>
        <View style={styles.invRow}>
          <View style={styles.invCol}>
            <Text style={styles.invName}>{inv.partyName}</Text>
            <Text style={linked ? styles.linkedStatus : styles.invitedStatus}>
              {linked ? 'Linked to device' : 'Invited'}
            </Text>
          </View>
          <Text style={styles.codePill}>{inv.code}</Text>
          <Pressable
            onPress={() => copyCode(inv.code)}
            hitSlop={8}
            style={styles.copyBtn}
          >
            <Text style={styles.copyText}>Copy</Text>
          </Pressable>
        </View>
        <View style={styles.regenActions}>
          <Pressable
            onPress={() => {
              setLastRegen(null);
              setRegenConfirmId(inv.id);
            }}
            hitSlop={8}
            style={styles.regenBtn}
          >
            <Text style={styles.regenText}>Regenerate code</Text>
          </Pressable>
        </View>
        {lastRegen && lastRegen.inviteId === inv.id ? (
          <View style={styles.regenNote}>
            <Text style={styles.regenNoteText}>
              <Text style={styles.regenNoteBold}>Regenerated</Text>
              {': the previous code '}
              <Text style={styles.strike}>{lastRegen.oldCode}</Text>
              {' no longer works, and the old device link is revoked.'}
            </Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
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

          {sides.map((s) => renderPartyBlock(s))}

          <Text style={styles.tcLabel}>Transaction coordinator</Text>
          {renderPartyBlock(tcMeta)}
          {latestVisible(invites, 'tc') ? (
            <Text style={styles.tcCapNote}>
              One transaction coordinator per escrow. Revoke the invite to invite someone new.
            </Text>
          ) : null}

          {regenInvite && (
            <View style={styles.confirmBox}>
              <Text style={styles.confirmTitle}>New code for {regenInvite.partyName}?</Text>
              <Text style={styles.confirmText}>
                {`A fresh single-use code is created for this ${regenSide?.noun ?? 'client'} : same escrow, same party. `}
                <Text style={styles.confirmBold}>The old code and its device link stop working.</Text>
              </Text>
              <View style={styles.confirmBtns}>
                <View style={styles.confirmPrimary}>
                  <Pressable
                    onPress={doRegenerate}
                    disabled={regenBusy}
                    style={[styles.createBtn, regenBusy && styles.createBtnBusy]}
                  >
                    <Text style={styles.createText}>
                      {regenBusy ? 'Creating…' : 'Create new code'}
                    </Text>
                  </Pressable>
                </View>
                <Pressable
                  onPress={() => setRegenConfirmId(null)}
                  hitSlop={8}
                  style={styles.keepBtn}
                  disabled={regenBusy}
                >
                  <Text style={styles.keepText}>Keep old</Text>
                </Pressable>
              </View>
            </View>
          )}

          <Text style={styles.hint}>
            {'Buyer and seller each get their '}
            <Text style={styles.hintBold}>own code</Text>
            {' for this escrow (one invite per side). The transaction coordinator gets their own code (one per escrow). '}
            <Text style={styles.hintBold}>Regenerate</Text>
            {' covers a reinstall or a new device: the old code was already consumed.'}
          </Text>
        </Card>
      </ScrollView>

      {sheetSide && (
        <InviteSheet
          visible
          side={sheetSide}
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
  tcLabel: {
    fontSize: 12,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
    fontWeight: '700',
    marginTop: 14,
    marginBottom: 2,
  } as TextStyle,
  tcCapNote: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.muted,
    marginTop: 2,
    marginBottom: 10,
  },
  invRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  invCol: {
    flex: 1,
  },
  invName: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.ink,
  },
  linkedStatus: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.sage,
    marginTop: 3,
  },
  invitedStatus: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.muted,
    marginTop: 3,
  },
  codePill: {
    fontSize: 17,
    fontWeight: '800',
    letterSpacing: 3,
    color: colors.ink,
    backgroundColor: '#F1ECE1',
    borderRadius: 12,
    paddingVertical: 9,
    paddingHorizontal: 16,
  },
  copyBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingLeft: 14,
    paddingRight: 4,
  },
  copyText: {
    color: colors.accent,
    fontSize: 14.5,
    fontWeight: '700',
  },
  regenActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
  },
  regenBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingLeft: 12,
  },
  regenText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  regenNote: {
    backgroundColor: '#FBFAF7',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginTop: 10,
  },
  regenNoteText: {
    fontSize: 13,
    lineHeight: 19.5,
    color: colors.body,
  },
  regenNoteBold: {
    fontWeight: '800',
    color: colors.ink,
  },
  strike: {
    textDecorationLine: 'line-through',
    textDecorationColor: colors.red,
    color: colors.muted,
    fontWeight: '700',
  },
  confirmBox: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 16,
    marginTop: 4,
  },
  confirmTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
  },
  confirmText: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.body,
    marginTop: 6,
  },
  confirmBold: {
    fontWeight: '800',
    color: colors.ink,
  },
  confirmBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 14,
  },
  confirmPrimary: {
    flex: 1,
  },
  createBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    backgroundColor: colors.accent,
    borderRadius: radius.button,
  },
  createBtnBusy: {
    opacity: 0.6,
  },
  createText: {
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
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.muted,
    marginTop: 12,
  },
  hintBold: {
    fontWeight: '800',
    color: colors.accent,
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
