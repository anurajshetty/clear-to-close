// Clear to Close — full-screen share/invite management.
// Faithful to APPROVED mockup 05 · share screen v1 (Sept 29, 2026).
// Replaces the invite bottom sheet (InviteSheet) and the view-clients overlay
// (ClientList): three sections — Buyers · X of 2, Sellers · X of 2,
// Transaction coordinator · X of 1 — with inline invite forms and inline
// remove/regenerate confirms. No overlays, no sheets: one screen.
//
// Unchanged: name + 6-char single-use code model; Invited vs Accepted pills
// (Accepted = redeemedAt != null); code + Copy on Invited rows only; the
// two-per-side cap with the quiet cap note; regenerate kills the old code and
// its device link; remove revokes the invite. The per-role caps (2 per side,
// 1 TC) are enforced in the store and by the DB trigger — no migration here.
// Closed/cancelled escrows never offer invite creation (Anuraj, Sept 28,
// 2026): the invite buttons/forms and cap notes are hidden, but viewing and
// removing/regenerating legacy live invites still works.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextStyle, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { store } from '../../src/lib/store-instance';
import { ToastTimer } from '../../src/lib/toast';
import type { ClientRole, Escrow, Invite } from '../../src/lib/types';
import {
  BackChevron,
  Card,
  Field,
  PrimaryButton,
  SecondaryButton,
  useKeyboardHeight,
} from '../../src/components/ui';
import { colors } from '../../src/theme';

interface SectionMeta {
  role: ClientRole;
  plural: string; // "Buyers" | "Sellers" | "Transaction coordinator"
  buttonNoun: string; // "buyer" | "seller" | "TC" — "Invite the buyer", "Invite the TC"
  nameLabel: string; // "Buyer's name" | "Seller's name" | "TC's name"
  cap: number; // 2 | 2 | 1
}

const SECTIONS: SectionMeta[] = [
  { role: 'buyer', plural: 'Buyers', buttonNoun: 'buyer', nameLabel: "Buyer's name", cap: 2 },
  { role: 'seller', plural: 'Sellers', buttonNoun: 'seller', nameLabel: "Seller's name", cap: 2 },
  { role: 'tc', plural: 'Transaction coordinator', buttonNoun: 'TC', nameLabel: "TC's name", cap: 1 },
];

/** Non-revoked invites, oldest first — revoked rows disappear from the list. */
function visibleInvites(invites: Invite[]): Invite[] {
  return invites
    .filter((i) => !i.revokedAt)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export default function ShareEscrow() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbHeight = useKeyboardHeight();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = params.id;
  const escrowId = Array.isArray(rawId) ? rawId[0] : rawId;

  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Toast (ToastTimer owns the dismiss timer — never inside an effect that
  // mutates unrelated state; the Sept 28 stuck-toast lesson).
  const toastTimer = useMemo(() => new ToastTimer(), []);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(toastTimer.visible);
  useEffect(() => toastTimer.subscribe(setToastVisible), [toastTimer]);
  const showToast = useCallback(
    (msg: string) => {
      setToastMsg(msg);
      toastTimer.show();
    },
    [toastTimer],
  );

  // Inline invite form (one open at a time): name phase -> code phase.
  const [formRole, setFormRole] = useState<ClientRole | null>(null);
  const [formPhase, setFormPhase] = useState<'name' | 'code'>('name');
  const [formName, setFormName] = useState('');
  const [formCode, setFormCode] = useState('');
  const [formBusy, setFormBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Inline confirms (one open at a time per kind; opening one closes the other).
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [regenId, setRegenId] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!escrowId) return;
    try {
      setEscrow(await store.getEscrow(escrowId));
      setInvites(await store.listInvites(escrowId));
    } catch (err) {
      console.warn('share refresh failed', err);
    } finally {
      setLoaded(true);
    }
  }, [escrowId]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  const openForm = (role: ClientRole) => {
    setFormRole(role);
    setFormPhase('name');
    setFormName('');
    setFormCode('');
    setFormBusy(false);
    setFormError(null);
  };
  const closeForm = () => {
    setFormRole(null);
    setFormPhase('name');
    setFormName('');
    setFormCode('');
    setFormBusy(false);
    setFormError(null);
  };

  const copyCode = async (code: string) => {
    try {
      await Clipboard.setStringAsync(code);
    } catch (err) {
      console.warn('clipboard failed', err);
    }
    showToast('Code copied.');
  };

  const createCode = async () => {
    if (!formRole || formBusy) return;
    const partyName = formName.trim();
    if (!partyName) return;
    setFormBusy(true);
    setFormError(null);
    try {
      // Synchronous write (Sept 28, 2026): createInvite throws when the code
      // is not confirmed on the server — the failure is shown inline, never
      // silent.
      const invite = await store.createInvite(escrowId!, formRole, partyName);
      setFormCode(invite.code);
      setFormPhase('code');
      await refresh();
    } catch (err) {
      setFormError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't create the invite. Check your connection and try again.",
      );
      console.warn('createInvite failed', err);
    } finally {
      setFormBusy(false);
    }
  };

  const finishInvite = async () => {
    closeForm();
    await refresh();
    showToast('Invite created.');
  };

  const doRemove = async () => {
    if (!removeId || actionBusy) return;
    setActionBusy(true);
    try {
      await store.revokeInvite(removeId);
      setRemoveId(null);
      await refresh();
      showToast('Invite removed.');
    } catch (err) {
      console.warn('revokeInvite failed', err);
      showToast('Could not remove the invite. Try again.');
    } finally {
      setActionBusy(false);
    }
  };

  const doRegenerate = async () => {
    if (!regenId || actionBusy) return;
    setActionBusy(true);
    try {
      await store.regenerateInvite(regenId);
      setRegenId(null);
      await refresh();
      showToast('New code created.');
    } catch (err) {
      console.warn('regenerateInvite failed', err);
      showToast('Could not create a new code. Try again.');
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

  const escrowOpen = escrow.status === 'open';
  const visible = visibleInvites(invites);
  const forRole = (role: ClientRole) => visible.filter((i) => i.role === role);

  const toggleRemove = (id: string) => {
    setRegenId(null);
    setRemoveId((cur) => (cur === id ? null : id));
  };
  const toggleRegen = (id: string) => {
    setRemoveId(null);
    setRegenId((cur) => (cur === id ? null : id));
  };

  const renderRow = (inv: Invite, first: boolean) => {
    const accepted = inv.redeemedAt != null;
    return (
      <View key={inv.id} style={[styles.invRow, first && styles.invRowFirst]}>
        <View style={styles.invNameRow}>
          <Text style={styles.invName} numberOfLines={1}>
            {inv.partyName}{' '}
            <Text style={accepted ? styles.pillAccepted : styles.pillInvited}>
              {accepted ? 'Accepted' : 'Invited'}
            </Text>
          </Text>
          <Pressable
            onPress={() => toggleRemove(inv.id)}
            hitSlop={8}
            style={styles.removeBtn}
            accessibilityRole="button"
            accessibilityLabel={`Remove invite for ${inv.partyName}`}
          >
            <Text style={styles.removeGlyph}>×</Text>
          </Pressable>
        </View>
        <View style={styles.invActions}>
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
            onPress={() => toggleRegen(inv.id)}
            hitSlop={8}
            style={styles.regenBtn}
            accessibilityRole="button"
            accessibilityLabel={`Regenerate code for ${inv.partyName}`}
          >
            <Text style={styles.regenText}>Regenerate</Text>
          </Pressable>
        </View>
        {removeId === inv.id && (
          <View style={styles.confirm}>
            <Text style={styles.confirmTitle}>Remove {inv.partyName}?</Text>
            <Text style={styles.confirmText}>
              The invite and its code stop working. You can send a fresh one anytime.
            </Text>
            <View style={styles.confirmBtns}>
              <View style={styles.confirmPrimary}>
                <Pressable
                  onPress={doRemove}
                  disabled={actionBusy}
                  style={[styles.dangerBtn, actionBusy && styles.btnBusy]}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${inv.partyName}'s invite`}
                >
                  <Text style={styles.dangerBtnText}>{actionBusy ? 'Removing…' : 'Remove'}</Text>
                </Pressable>
              </View>
              <Pressable
                onPress={() => setRemoveId(null)}
                disabled={actionBusy}
                hitSlop={8}
                style={styles.keepBtn}
              >
                <Text style={styles.keepText}>Keep</Text>
              </Pressable>
            </View>
          </View>
        )}
        {regenId === inv.id && (
          <View style={styles.confirm}>
            <Text style={styles.confirmTitle}>New code for {inv.partyName}?</Text>
            <Text style={styles.confirmText}>
              The old code stops working. Any linked device loses access to this escrow.
            </Text>
            <View style={styles.confirmBtns}>
              <View style={styles.confirmPrimary}>
                <Pressable
                  onPress={doRegenerate}
                  disabled={actionBusy}
                  style={[styles.createBtn, actionBusy && styles.btnBusy]}
                  accessibilityRole="button"
                  accessibilityLabel={`Create new code for ${inv.partyName}`}
                >
                  <Text style={styles.createBtnText}>
                    {actionBusy ? 'Creating…' : 'Create new code'}
                  </Text>
                </Pressable>
              </View>
              <Pressable
                onPress={() => setRegenId(null)}
                disabled={actionBusy}
                hitSlop={8}
                style={styles.keepBtn}
              >
                <Text style={styles.keepText}>Keep</Text>
              </Pressable>
            </View>
          </View>
        )}
      </View>
    );
  };

  const renderForm = (s: SectionMeta) => {
    if (formRole !== s.role) return null;
    const nameOk = formName.trim().length > 0;
    return (
      <View style={styles.invForm}>
        {formPhase === 'name' ? (
          <View>
            <Field
              label={s.nameLabel}
              value={formName}
              onChangeText={(t) => setFormName(t.slice(0, 30))}
              placeholder={s.nameLabel}
              autoCapitalize="words"
              autoCorrect={false}
              testID={`share-name-${s.role}`}
            />
            <Text style={styles.hint}>They’ll enter this exact name with the code. It has to match.</Text>
            {formError ? <Text style={styles.error}>{formError}</Text> : null}
            <View style={styles.formBtn}>
              <PrimaryButton
                title={formBusy ? 'Creating…' : 'Create code'}
                onPress={createCode}
                disabled={!nameOk || formBusy}
              />
            </View>
            <Pressable onPress={closeForm} hitSlop={8} style={styles.quietBtn}>
              <Text style={styles.quietText}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.codePhase}>
            <Text style={styles.bigCode}>{formCode}</Text>
            <Text style={styles.hintCenter}>Share this code with them. It works once.</Text>
            <View style={styles.codeBtns}>
              <PrimaryButton title="Copy" onPress={() => copyCode(formCode)} />
            </View>
            <Pressable onPress={finishInvite} hitSlop={8} style={styles.quietBtn}>
              <Text style={styles.quietText}>Done</Text>
            </Pressable>
          </View>
        )}
      </View>
    );
  };

  const renderSection = (s: SectionMeta) => {
    const rows = forRole(s.role);
    const count = rows.length;
    const formOpen = formRole === s.role;
    // Dead escrows never offer invite creation (Sept 28, 2026): the button,
    // the form, and the cap note are hidden; rows stay manageable.
    const showInviteUi = escrowOpen && count < s.cap && !formOpen;
    const showCapNote = escrowOpen && count >= s.cap && s.cap > 1;
    const buttonTitle =
      s.role === 'tc'
        ? 'Invite the TC'
        : count === 0
          ? `Invite the ${s.buttonNoun}`
          : `Invite another ${s.buttonNoun}`;
    return (
      <View key={s.role}>
        <Text style={styles.sectionLabel}>
          {s.plural} · {count} of {s.cap}
        </Text>
        {rows.map((inv, idx) => renderRow(inv, idx === 0))}
        {renderForm(s)}
        {showInviteUi && (
          <View style={styles.inviteBtnWrap}>
            <SecondaryButton title={buttonTitle} onPress={() => openForm(s.role)} />
          </View>
        )}
        {showCapNote && (
          <View style={styles.capNote}>
            <Text style={styles.capNoteText}>
              <Text style={styles.capNoteBold}>Two invites max per side. </Text>
              Remove one to invite someone new.
            </Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={[styles.screen, { paddingBottom: kbHeight }]}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <View style={styles.backBtn}>
          <BackChevron label="Details" onPress={() => router.back()} />
        </View>
        <Text style={styles.title}>Share this escrow</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {escrow.address} · {escrow.city}
        </Text>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        <Text style={styles.hintLine}>Invite your clients and your TC. Each person gets a name and a one-time code.</Text>
        <Card>{SECTIONS.map(renderSection)}</Card>
      </ScrollView>
      {toastVisible && toastMsg ? (
        <Pressable
          style={styles.toast}
          onPress={() => toastTimer.dismiss()}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          testID="share-toast"
        >
          <Text style={styles.toastText}>{toastMsg}</Text>
        </Pressable>
      ) : null}
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
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.2,
    marginTop: 2,
  },
  subtitle: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 4,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 18,
    paddingTop: 14,
    paddingBottom: 36,
  },
  hintLine: {
    fontSize: 14,
    lineHeight: 22,
    color: colors.body,
    marginHorizontal: 2,
    marginBottom: 12,
  },
  sectionLabel: {
    fontSize: 12,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
    fontWeight: '700',
    marginTop: 20,
    marginBottom: 4,
  } as TextStyle,
  invRow: {
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  invRowFirst: {
    borderTopWidth: 0,
  },
  invNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  invName: {
    flex: 1,
    fontSize: 15.5,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 21,
  },
  pillInvited: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.amber,
    backgroundColor: colors.amberSoft,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  } as TextStyle,
  pillAccepted: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.accent,
    backgroundColor: colors.accentSoft,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
  } as TextStyle,
  removeBtn: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
    marginLeft: 8,
  },
  removeGlyph: {
    fontSize: 22,
    lineHeight: 22,
    color: colors.red,
    fontWeight: '400',
  },
  invActions: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    flexWrap: 'wrap',
  },
  codeChip: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 3,
    color: colors.ink,
    backgroundColor: '#F4F0E7',
    borderRadius: 10,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  copyBtn: {
    minHeight: 44,
    minWidth: 52,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: 10,
  },
  copyText: {
    color: colors.accent,
    fontSize: 14.5,
    fontWeight: '700',
  },
  regenBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderRadius: 10,
    marginLeft: 'auto',
  },
  regenText: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  confirm: {
    backgroundColor: '#FBFAF7',
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 16,
    marginTop: 10,
  },
  confirmTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: 6,
  },
  confirmText: {
    fontSize: 14,
    lineHeight: 22,
    color: colors.body,
    marginBottom: 14,
  },
  confirmBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  confirmPrimary: {
    flex: 1,
  },
  dangerBtn: {
    backgroundColor: colors.red,
    borderRadius: 14,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  createBtn: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  createBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  btnBusy: {
    opacity: 0.6,
  },
  keepBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  keepText: {
    color: colors.muted,
    fontSize: 15,
    fontWeight: '700',
  },
  invForm: {
    marginTop: 12,
    backgroundColor: '#FBFAF7',
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: 14,
    padding: 16,
  },
  hint: {
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.muted,
    marginTop: 10,
    marginHorizontal: 2,
  },
  error: {
    fontSize: 13,
    color: colors.red,
    marginTop: 6,
  },
  formBtn: {
    marginTop: 14,
  },
  quietBtn: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  quietText: {
    color: colors.muted,
    fontSize: 15,
    fontWeight: '700',
  },
  codePhase: {
    alignItems: 'center',
  },
  bigCode: {
    fontSize: 38,
    fontWeight: '700',
    letterSpacing: 11,
    color: colors.ink,
    textAlign: 'center',
    marginVertical: 14,
    paddingLeft: 11,
  },
  hintCenter: {
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.body,
    textAlign: 'center',
  },
  codeBtns: {
    width: '100%',
    marginTop: 14,
  },
  inviteBtnWrap: {
    marginTop: 10,
  },
  capNote: {
    backgroundColor: '#FBFAF7',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginTop: 12,
  },
  capNoteText: {
    fontSize: 13,
    lineHeight: 20,
    color: colors.muted,
  },
  capNoteBold: {
    fontWeight: '700',
    color: colors.body,
  },
  toast: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 28,
    backgroundColor: colors.ink,
    borderRadius: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '600',
    textAlign: 'center',
  },
});
