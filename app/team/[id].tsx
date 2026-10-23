// Clear to Close — Team on this escrow (Team Access, frame 3).
// One Associate seat ("Can edit everything") and one TC seat ("Edits
// intakes only") per escrow. Filled seats show the person + Remove;
// pending seats show the invited email + Cancel; each empty seat has
// its own Add button opening that seat's invite form inline (Oct 23,
// 2026 redesign, frames 1–4: no shared form, no placeholder card). A
// redeemed legacy TC code link (from before Team Access) gets its own
// "view-only" row with Revoke under the TC seat, whatever the account
// seat's state (Q1). On a closed or cancelled escrow the sheet is the
// final record: no invite or remove actions render at all.
// Owner-only surface: members never see team management (frame 6).
import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { store } from '../../src/lib/store-instance';
import type { Escrow, Invite } from '../../src/lib/types';
import { visibleInvites } from '../../src/lib/invites';
import {
  accessRoleOf,
  addInviteLabel,
  invitesFrozen,
  legacyTcInvite,
  seatEmailLabel,
  seatFor,
  teamFinalExplainer,
  teamRoleCapability,
  teamRoleSeatTitle,
  waitingForName,
  type GrantRole,
} from '../../src/lib/teamAccess';
import type {
  TeamParticipantMember,
  TeamParticipants,
} from '../../src/lib/teamModel';
import {
  BackChevron,
  Card,
  ConfirmDialog,
  Field,
  PrimaryButton,
  SecondaryButton,
  initialsOf,
  useKeyboardHeight,
} from '../../src/components/ui';
import { formatShortDate } from '../../src/components/TimeTrackerCard';
import { colors } from '../../src/theme';
import { partyLine } from '../index';


const SIDE_KICKER: Record<Escrow['side'], string> = {
  buy: 'Buy side',
  sell: 'Sell side',
  both: 'Both sides',
};

function seatInitials(seat: TeamParticipantMember): string {
  const name = (seat.name ?? '').trim();
  if (name) return initialsOf(name);
  const local = (seat.invitedEmail ?? '').split('@')[0].replace(/[._-]+/g, ' ').trim();
  return initialsOf(local || '?');
}

export default function TeamOnEscrow() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbHeight = useKeyboardHeight();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = params.id;
  const escrowId = Array.isArray(rawId) ? rawId[0] : rawId;

  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [participants, setParticipants] = useState<TeamParticipants | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);

  // Per-seat invite forms (redesign frames 2–3): each seat's form opens
  // independently, with its own email, busy, and error state.
  interface SeatForm {
    open: boolean;
    email: string;
    busy: boolean;
    error: string | null;
  }
  const closedForm: SeatForm = { open: false, email: '', busy: false, error: null };
  const [seatForms, setSeatForms] = useState<Record<GrantRole, SeatForm>>({
    associate: closedForm,
    tc: closedForm,
  });
  const patchForm = (role: GrantRole, patch: Partial<SeatForm>) =>
    setSeatForms((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }));

  const [removing, setRemoving] = useState<TeamParticipantMember | null>(null);
  const [revokingLegacy, setRevokingLegacy] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);

  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  };

  const refresh = useCallback(async () => {
    if (!escrowId) return;
    try {
      setEscrow(await store.getEscrow(escrowId));
    } catch (err) {
      console.warn('team getEscrow failed', err);
    }
    try {
      setInvites(await store.listInvites(escrowId));
    } catch (err) {
      console.warn('team listInvites failed', err);
    }
    try {
      const result = await store.getEscrowParticipants(escrowId);
      setParticipants(result);
      // Null = the server did not confirm this account's access (or sync
      // is unavailable): surface the error state, never phantom seats.
      setLoadError(result == null);
    } catch (err) {
      console.warn('getEscrowParticipants failed', err);
      setLoadError(true);
    }
    setLoaded(true);
  }, [escrowId]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const legacyTc = useMemo(() => legacyTcInvite(visibleInvites(invites)), [invites]);

  const assocSeat = seatFor(participants, 'associate');
  const tcSeat = seatFor(participants, 'tc');

  const sendInvite = async (role: GrantRole) => {
    const form = seatForms[role];
    if (!escrowId || form.busy) return;
    const value = form.email.trim();
    if (!/.+@.+\..+/.test(value)) {
      patchForm(role, { error: 'Enter a valid email address.' });
      return;
    }
    patchForm(role, { busy: true, error: null });
    try {
      const res = await store.createTeamInvite(escrowId, value, role);
      if (res && res.ok) {
        patchForm(role, { open: false, email: '', busy: false, error: null });
        await refresh();
        showToast('Invite sent.');
      } else if (res && res.error === 'seat_taken') {
        patchForm(role, {
          busy: false,
          error: 'That seat is already taken. Remove the current person first.',
        });
      } else {
        patchForm(role, {
          busy: false,
          error: "Couldn't send the invite. Check the connection and try again.",
        });
      }
    } catch (err) {
      console.warn('createTeamInvite failed', err);
      patchForm(role, {
        busy: false,
        error: "Couldn't send the invite. Check the connection and try again.",
      });
    }
  };

  const cancelPending = async (seat: TeamParticipantMember) => {
    if (actionBusy) return;
    setActionBusy(true);
    try {
      await store.cancelTeamInvite(seat.grantId);
      await refresh();
      showToast('Invite cancelled.');
    } catch (err) {
      console.warn('cancelTeamInvite failed', err);
      showToast("Couldn't cancel the invite. Try again.");
    } finally {
      setActionBusy(false);
    }
  };

  const doRemove = async () => {
    if (!removing || actionBusy) return;
    setActionBusy(true);
    try {
      await store.removeTeamMember(removing.grantId);
      setRemoving(null);
      await refresh();
      showToast('Removed from this escrow.');
    } catch (err) {
      console.warn('removeTeamMember failed', err);
      showToast("Couldn't remove them. Try again.");
    } finally {
      setActionBusy(false);
    }
  };

  const doRevokeLegacy = async () => {
    if (!legacyTc || actionBusy) return;
    setActionBusy(true);
    try {
      await store.revokeInvite(legacyTc.id);
      setRevokingLegacy(false);
      await refresh();
      showToast('TC link revoked.');
    } catch (err) {
      console.warn('revokeInvite (legacy TC) failed', err);
      showToast("Couldn't revoke the link. Try again.");
    } finally {
      setActionBusy(false);
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

  // Owner-only: a member who lands here (old link, typed route) gets a
  // plain dead end with a way back — team management is never rendered.
  if (accessRoleOf(escrow) !== 'owner') {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>
          Only the escrow's owner manages its team.
        </Text>
        <View style={styles.centerBtn}>
          <SecondaryButton title="Back to the escrow" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  const frozen = invitesFrozen(escrow);

  const renderSeat = (role: GrantRole, seat: TeamParticipantMember | null) => {
    const form = seatForms[role];
    return (
      <View key={role} style={styles.seat}>
        <View style={styles.seatHead}>
          <Text style={styles.seatTitle}>{teamRoleSeatTitle(role)}</Text>
          <View style={[styles.capPill, role === 'tc' ? styles.capPillTc : styles.capPillAssoc]}>
            <Text style={[styles.capPillText, role === 'tc' ? styles.capPillTextTc : styles.capPillTextAssoc]}>
              {teamRoleCapability(role)}
            </Text>
          </View>
        </View>
        {seat || (role === 'tc' && legacyTc) ? (
          <Card style={styles.seatCard}>
            {seat ? (
              <View style={styles.personRow}>
                <View style={[styles.avatar, role === 'tc' && styles.avatarGold]}>
                  <Text style={[styles.avatarText, role === 'tc' && styles.avatarTextGold]}>
                    {seatInitials(seat)}
                  </Text>
                </View>
                <View style={styles.personText}>
                  <Text style={styles.personName} numberOfLines={1}>
                    {seat.status === 'accepted'
                      ? (seat.name ?? seat.invitedEmail ?? '')
                      : (seat.invitedEmail ?? seat.name ?? '')}
                  </Text>
                  <Text style={styles.personStatus}>
                    {seat.status === 'accepted'
                      ? `Accepted · on this escrow since ${seat.acceptedAt ? formatShortDate(seat.acceptedAt) : ''}`
                      : `Invite sent · waiting for ${waitingForName(seat)} to accept`}
                  </Text>
                </View>
                {!frozen && seat.status === 'accepted' ? (
                  <Pressable
                    onPress={() => setRemoving(seat)}
                    hitSlop={8}
                    style={styles.removeBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${seat.name ?? seat.invitedEmail ?? 'member'} from this escrow`}
                  >
                    <Text style={styles.removeText}>Remove</Text>
                  </Pressable>
                ) : !frozen ? (
                  <Pressable
                    onPress={() => cancelPending(seat)}
                    hitSlop={8}
                    style={styles.removeBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Cancel the invite to ${seat.invitedEmail ?? 'this person'}`}
                  >
                    <Text style={styles.removeText}>Cancel</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {role === 'tc' && legacyTc ? (
              <View style={[styles.legacyRow, !seat && styles.legacyRowSolo]}>
                <View style={styles.personText}>
                  <Text style={styles.legacyTitle}>TC link (from before) · view-only</Text>
                  <Text style={styles.personStatus}>
                    {legacyTc.partyName} joined with a code. That access still works.
                  </Text>
                </View>
                {!frozen ? (
                  <Pressable
                    onPress={() => setRevokingLegacy(true)}
                    hitSlop={8}
                    style={styles.removeBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Revoke the legacy TC link"
                  >
                    <Text style={styles.removeText}>Revoke</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </Card>
        ) : null}
        {!seat && !frozen ? (
          form.open ? (
            <View style={styles.seatForm}>
              <Field
                label={seatEmailLabel(role)}
                value={form.email}
                onChangeText={(t) => patchForm(role, { email: t.slice(0, 80) })}
                placeholder="name@example.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                testID={`team-invite-email-${role}`}
              />
              {form.error ? <Text style={styles.error}>{form.error}</Text> : null}
              <View style={styles.formBtn}>
                <PrimaryButton
                  title={form.busy ? 'Sending…' : 'Send invite'}
                  onPress={() => sendInvite(role)}
                  disabled={form.busy || !form.email.trim()}
                />
              </View>
              <Pressable
                onPress={() => patchForm(role, { open: false, email: '', error: null })}
                style={styles.cancelBtn}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => patchForm(role, { open: true })}
              style={styles.addBtn}
              accessibilityRole="button"
              accessibilityLabel={addInviteLabel(role)}
            >
              <Text style={styles.addBtnText}>{addInviteLabel(role)}</Text>
            </Pressable>
          )
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.screen, { paddingBottom: kbHeight }]}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <View style={styles.backBtn}>
          <BackChevron label="Details" onPress={() => router.back()} />
        </View>
        <Text style={styles.kicker}>
          {SIDE_KICKER[escrow.side]} ·{' '}
          {frozen
            ? escrow.status === 'closed'
              ? 'Closed'
              : 'Cancelled'
            : `Closes ${formatShortDate(escrow.closeDate)}`}
        </Text>
        <Text style={styles.title} numberOfLines={2}>
          {escrow.address}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {partyLine(escrow)}
        </Text>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        <Text style={styles.h3}>Team on this escrow</Text>
        <Text style={styles.explainer}>
          {frozen
            ? teamFinalExplainer(escrow)
            : 'One Associate and one TC can help you on this escrow. They sign in with their own accounts.'}
        </Text>

        {loadError ? (
          <Text style={styles.error}>
            Couldn't load the team. Check your connection and reopen this screen.
          </Text>
        ) : participants ? (
          <>
            {renderSeat('associate', assocSeat)}
            {renderSeat('tc', tcSeat)}
          </>
        ) : (
          <Text style={styles.seatEmpty}>Loading the team…</Text>
        )}
      </ScrollView>

      <ConfirmDialog
        visible={removing != null}
        title={removing ? `Remove ${removing.name ?? removing.invitedEmail ?? 'this person'}?` : ''}
        message="They lose access to this escrow right away. Their past work stays in the activity log, and you can invite them again anytime."
        confirmTitle="Remove"
        busyTitle="Removing…"
        cancelTitle="Keep"
        destructive
        busy={actionBusy}
        onConfirm={doRemove}
        onCancel={() => setRemoving(null)}
      />
      <ConfirmDialog
        visible={revokingLegacy}
        title="Revoke the TC link?"
        message="The TC who joined with the code loses access to this escrow right away."
        confirmTitle="Revoke"
        busyTitle="Revoking…"
        cancelTitle="Keep"
        destructive
        busy={actionBusy}
        onConfirm={doRevokeLegacy}
        onCancel={() => setRevokingLegacy(false)}
      />

      {toastMsg && (
        <View style={styles.toast} testID="team-toast">
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paper,
    padding: 24,
  },
  centerText: {
    fontSize: 15,
    color: colors.body,
    textAlign: 'center',
  },
  centerBtn: {
    marginTop: 16,
    minWidth: 200,
  },
  header: {
    paddingHorizontal: 18,
    paddingBottom: 12,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  backBtn: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
  },
  kicker: {
    fontSize: 12,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
    color: colors.accent,
    fontWeight: '700',
    marginTop: 2,
  },
  title: {
    fontSize: 21,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 4,
  },
  subtitle: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 3,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 18,
    paddingTop: 14,
    paddingBottom: 36,
  },
  h3: {
    fontSize: 19,
    fontWeight: '700',
    color: colors.ink,
  },
  explainer: {
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.body,
    marginTop: 4,
  },
  seat: {
    marginTop: 18,
  },
  seatHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  seatTitle: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  capPill: {
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
  capPillAssoc: {
    backgroundColor: colors.accentSoft,
  },
  capPillTc: {
    backgroundColor: colors.amberSoft,
  },
  capPillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  capPillTextAssoc: {
    color: colors.accent,
  },
  capPillTextTc: {
    color: colors.amber,
  },
  seatCard: {
    padding: 14,
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  avatarGold: {
    backgroundColor: colors.gold,
  },
  avatarText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  avatarTextGold: {
    color: colors.ink,
  },
  personText: {
    flex: 1,
  },
  personName: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
  },
  personStatus: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 2,
  },
  removeBtn: {
    minHeight: 44,
    minWidth: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingLeft: 8,
  },
  removeText: {
    color: colors.red,
    fontSize: 14,
    fontWeight: '700',
  },
  seatEmpty: {
    fontSize: 13.5,
    color: colors.muted,
  },
  legacyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    marginTop: 12,
    paddingTop: 12,
  },
  legacyRowSolo: {
    borderTopWidth: 0,
    marginTop: 0,
    paddingTop: 0,
  },
  legacyTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.ink,
  },
  addBtn: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: '#B9AE97',
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  addBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.accent,
  },
  seatForm: {
    marginTop: 2,
  },
  cancelBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    minHeight: 44,
  },
  cancelText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.body,
  },
  error: {
    fontSize: 13,
    color: colors.red,
    marginTop: 10,
  },
  formBtn: {
    marginTop: 16,
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
