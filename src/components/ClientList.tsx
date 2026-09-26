// Clear to Close — client-list overlay for the transaction detail.
// Faithful to APPROVED mockup 01 · device ②/③ (invite-client flow, Sept 25):
// per-side client list with Invited/Accepted status pills, code chip + Copy
// on Invited rows only, Regenerate / Revoke with confirmation, "Invite
// another" up to the two-per-side cap, quiet cap note at the cap.
// Regenerate = fresh code for the same client (old code dies, old device link
// revoked); Revoke = the client link is killed entirely.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextStyle,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { store } from '../lib/store-instance';
import { MAX_CLIENTS_PER_SIDE } from '../lib/store';
import type { ClientRole, Invite } from '../lib/types';
import { InviteSheet } from './InviteSheet';
import { Kicker, PrimaryButton, SecondaryButton, Sheet } from './ui';
import { colors } from '../theme';

export function ClientList({
  visible,
  escrowId,
  address,
  side,
  onClose,
}: {
  visible: boolean;
  escrowId: string;
  address: string;
  side: ClientRole;
  onClose: () => void;
}) {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [regenId, setRegenId] = useState<string | null>(null);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const label = side === 'buyer' ? 'Buyer' : 'Seller';
  const noun = side === 'buyer' ? 'buyer' : 'seller';

  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  };

  const refresh = useCallback(async () => {
    try {
      const all = await store.listInvites(escrowId);
      // Revoked invites are removed from the list (the row disappears).
      setInvites(all.filter((i) => i.role === side && !i.revokedAt));
    } catch (err) {
      console.warn('ClientList listInvites failed', err);
    }
  }, [escrowId, side]);

  useEffect(() => {
    if (visible) {
      setRegenId(null);
      setRevokeId(null);
      setSheetOpen(false);
      setBusy(false);
      refresh();
    }
  }, [visible, refresh]);

  const copyCode = async (code: string) => {
    try {
      await Clipboard.setStringAsync(code);
    } catch (err) {
      console.warn('clipboard failed', err);
    }
    showToast('Code copied.');
  };

  const doRegenerate = async () => {
    if (!regenId || busy) return;
    setBusy(true);
    try {
      await store.regenerateInvite(regenId);
      setRegenId(null);
      showToast('New code issued — the old code no longer works.');
      await refresh();
    } catch (err) {
      console.warn('regenerateInvite failed', err);
      showToast('Could not create a new code — try again.');
    } finally {
      setBusy(false);
    }
  };

  const doRevoke = async () => {
    if (!revokeId || busy) return;
    setBusy(true);
    try {
      await store.revokeInvite(revokeId);
      setRevokeId(null);
      showToast('Invite removed.');
      await refresh();
    } catch (err) {
      console.warn('revokeInvite failed', err);
      showToast('Could not remove the invite — try again.');
    } finally {
      setBusy(false);
    }
  };

  const regenInvite = regenId ? invites.find((i) => i.id === regenId) ?? null : null;
  const revokeInvite = revokeId ? invites.find((i) => i.id === revokeId) ?? null : null;

  return (
    <>
      <Sheet visible={visible} onClose={onClose}>
        <View style={styles.wrap}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <Kicker>Clients — {address}</Kicker>
            <Text style={styles.title}>View clients</Text>

            <Text style={styles.seclab}>
              {label} · {invites.length} of {MAX_CLIENTS_PER_SIDE}
            </Text>

            {invites.map((inv, idx) => {
              const accepted = !!inv.redeemedAt;
              return (
                <View
                  key={inv.id}
                  style={[styles.row, idx === 0 && styles.rowFirst]}
                >
                  <View style={styles.nameRow}>
                    <View style={styles.nameCol}>
                      <View style={styles.nameLine}>
                        <Text style={styles.name} numberOfLines={1}>
                          {inv.partyName}
                        </Text>
                        <View
                          style={[
                            styles.pill,
                            accepted ? styles.pillAccepted : styles.pillInvited,
                          ]}
                        >
                          <Text
                            style={[
                              styles.pillText,
                              accepted ? styles.pillTextAccepted : styles.pillTextInvited,
                            ]}
                          >
                            {accepted ? 'Accepted' : 'Invited'}
                          </Text>
                        </View>
                      </View>
                    </View>
                    <Pressable
                      onPress={() => {
                        setRegenId(null);
                        setRevokeId(inv.id);
                      }}
                      hitSlop={8}
                      style={styles.removeBtn}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove invite for ${inv.partyName}`}
                    >
                      <Text style={styles.removeText}>×</Text>
                    </Pressable>
                  </View>
                  <View style={styles.actionsRow}>
                    {!accepted && (
                      <>
                        <Text style={styles.codeChip}>{inv.code}</Text>
                        <Pressable
                          onPress={() => copyCode(inv.code)}
                          hitSlop={8}
                          style={styles.copyBtn}
                          accessibilityRole="button"
                          accessibilityLabel={`Copy invite code for ${inv.partyName}`}
                        >
                          <Text style={styles.copyText}>Copy</Text>
                        </Pressable>
                      </>
                    )}
                    <Pressable
                      onPress={() => {
                        setRevokeId(null);
                        setRegenId(inv.id);
                      }}
                      hitSlop={8}
                      style={styles.regenBtn}
                      accessibilityRole="button"
                      accessibilityLabel={`Regenerate code for ${inv.partyName}`}
                    >
                      <Text style={styles.regenText}>Regenerate</Text>
                    </Pressable>
                  </View>
                </View>
              );
            })}

            {invites.length < MAX_CLIENTS_PER_SIDE ? (
              <View style={styles.inviteAnother}>
                <SecondaryButton
                  title={`Invite another ${noun}`}
                  onPress={() => setSheetOpen(true)}
                />
              </View>
            ) : (
              <Text style={styles.capnote}>
                <Text style={styles.capBold}>Two invites max per side.</Text>
                {' Revoke one to invite someone new.'}
              </Text>
            )}

            {regenInvite && (
              <View style={styles.confirmBox}>
                <Text style={styles.confirmTitle}>
                  New code for {regenInvite.partyName}?
                </Text>
                <Text style={styles.confirmText}>
                  The old code stops working — any linked device loses access to
                  this escrow.
                </Text>
                <View style={styles.confirmBtns}>
                  <View style={styles.confirmPrimary}>
                    <PrimaryButton
                      title={busy ? 'Creating…' : 'Create new code'}
                      onPress={doRegenerate}
                      disabled={busy}
                    />
                  </View>
                  <Pressable
                    onPress={() => setRegenId(null)}
                    hitSlop={8}
                    style={styles.keepBtn}
                    disabled={busy}
                  >
                    <Text style={styles.keepText}>Keep old</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {revokeInvite && (
              <View style={styles.confirmBox}>
                <Text style={styles.confirmTitle}>
                  Remove {revokeInvite.partyName}&rsquo;s invite?
                </Text>
                <Text style={styles.confirmText}>
                  {revokeInvite.redeemedAt
                    ? 'Their invite stops working and their linked device loses access to this escrow. You can send them a fresh invite anytime.'
                    : 'The invite and its code stop working. You can send them a fresh one anytime.'}
                </Text>
                <View style={styles.confirmBtns}>
                  <View style={styles.confirmPrimary}>
                    <Pressable
                      onPress={doRevoke}
                      disabled={busy}
                      style={[styles.removeBtnFull, busy && styles.btnBusy]}
                      accessibilityRole="button"
                    >
                      <Text style={styles.removeBtnFullText}>
                        {busy ? 'Removing…' : 'Remove'}
                      </Text>
                    </Pressable>
                  </View>
                  <Pressable
                    onPress={() => setRevokeId(null)}
                    hitSlop={8}
                    style={styles.keepBtn}
                    disabled={busy}
                  >
                    <Text style={styles.keepText}>Keep</Text>
                  </Pressable>
                </View>
              </View>
            )}
          </ScrollView>

          {toastMsg && (
            <View style={styles.toast} pointerEvents="none">
              <Text style={styles.toastText}>{toastMsg}</Text>
            </View>
          )}
        </View>
      </Sheet>

      {sheetOpen && (
        <InviteSheet
          visible
          side={side}
          address={address}
          escrowId={escrowId}
          onClose={() => setSheetOpen(false)}
          onCreated={refresh}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  wrap: {
    // The toast is absolutely positioned inside the sheet.
  },
  scroll: {
    maxHeight: 480,
  },
  scrollContent: {
    paddingBottom: 8,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 8,
  },
  seclab: {
    fontSize: 12,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
    fontWeight: '700',
    marginTop: 18,
    marginBottom: 4,
  } as TextStyle,
  row: {
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    minHeight: 64,
  },
  rowFirst: {
    borderTopWidth: 0,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  nameCol: {
    flex: 1,
  },
  nameLine: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  name: {
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.ink,
    flexShrink: 1,
  },
  pill: {
    borderRadius: 6,
    paddingVertical: 3,
    paddingHorizontal: 8,
    marginLeft: 6,
  },
  pillInvited: {
    backgroundColor: colors.amberSoft,
  },
  pillAccepted: {
    backgroundColor: colors.accentSoft,
  },
  pillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  } as TextStyle,
  pillTextInvited: {
    color: colors.amber,
  },
  pillTextAccepted: {
    color: colors.accent,
  },
  removeBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeText: {
    color: colors.red,
    fontSize: 22,
    fontWeight: '400',
    lineHeight: 24,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    flexWrap: 'wrap',
  },
  codeChip: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 2.7,
    color: colors.ink,
    backgroundColor: '#F4F0E7',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  copyBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  copyText: {
    color: colors.accent,
    fontSize: 14.5,
    fontWeight: '700',
  },
  regenBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  regenText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  inviteAnother: {
    marginTop: 10,
  },
  capnote: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.muted,
    backgroundColor: '#FBFAF7',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 12,
  },
  capBold: {
    fontWeight: '800',
    color: colors.body,
  },
  confirmBox: {
    backgroundColor: colors.paper,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 16,
    marginTop: 14,
  },
  confirmTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
  },
  confirmText: {
    fontSize: 14.5,
    lineHeight: 22,
    color: colors.body,
    marginTop: 6,
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
  removeBtnFull: {
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    minHeight: 52,
    backgroundColor: colors.red,
    borderRadius: 14,
  },
  removeBtnFullText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  btnBusy: {
    opacity: 0.6,
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
  toast: {
    position: 'absolute',
    left: 4,
    right: 4,
    bottom: 24,
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
    textAlign: 'center',
  },
});
