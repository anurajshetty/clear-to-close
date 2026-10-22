import React, { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRouter } from 'expo-router';
import { auth } from '../src/lib/auth';
import { store } from '../src/lib/store-instance';
import { shouldShowProfileNudge } from '../src/lib/bootRoute';
import type { ClientRole, Escrow, RealtorProfile, StepT } from '../src/lib/types';
import { DealCard } from '../src/components/DealCard';
import { SectionHeader } from '../src/components/SectionHeader';
import { BannerStrip } from '../src/components/BannerStrip';
import { displayBannerUri, displayPhotoUri } from '../src/lib/profile';
import { TOPCARD_TOKENS } from '../src/lib/topCard';
import { daysToClose } from '../src/lib/dates';
import { closedDisplayDate, isClosedRow } from '../src/lib/lifecycle';
import { formatShortDate } from '../src/components/TimeTrackerCard';
import { Kicker, PrimaryButton, Card, initialsOf } from '../src/components/ui';
import {
  accessRoleOf,
  ownerNameOf,
  pendingInviteAbilityLine,
  teamRoleSeatTitle,
} from '../src/lib/teamAccess';
import type { TeamPendingInvite } from '../src/lib/teamModel';
import NewEscrowSheet from '../src/components/NewEscrowSheet';
import UpdateEscrowSheet from '../src/components/UpdateEscrowSheet';
import CancelEscrowSheet from '../src/components/CancelEscrowSheet';
import { colors } from '../src/theme';

export type Role = ClientRole;

// Invited deal card side pill tokens — same values as DealCard's.
const INVITED_SIDE_LABEL: Record<Escrow['side'], string> = {
  buy: 'Buy side',
  sell: 'Sell side',
  both: 'Both',
};
const INVITED_SIDE_FG: Record<Escrow['side'], string> = {
  buy: colors.accent,
  sell: colors.sellBrown,
  both: colors.bothInk,
};
const INVITED_SIDE_BG: Record<Escrow['side'], string> = {
  buy: colors.accentSoft,
  sell: colors.sellSoft,
  both: colors.bothSoft,
};

/** "Buyer: Priya Nair" — the client line on the deal card. */
export function partyLine(e: Escrow): string {
  const buyer = e.buyerName?.trim() ?? '';
  const seller = e.sellerName?.trim() ?? '';
  if (e.side === 'both') {
    return `Buyer: ${buyer} · Seller: ${seller}`;
  }
  if (e.side === 'sell') {
    return `Seller: ${seller}`;
  }
  return `Buyer: ${buyer}`;
}

function stepsFor(e: Escrow, role: Role): StepT[] {
  return role === 'buyer' ? e.buyerSteps : e.sellerSteps;
}

function countDone(steps: StepT[]): number {
  return steps.reduce((n, s) => n + (s.done ? 1 : 0), 0);
}

interface CardBits {
  done: number;
  total: number;
  fracLabel: string;
  frac: number;
}

function cardBits(e: Escrow): CardBits {
  if (e.side === 'both') {
    const b = stepsFor(e, 'buyer');
    const s = stepsFor(e, 'seller');
    const bDone = countDone(b);
    const sDone = countDone(s);
    const total = b.length + s.length;
    const done = bDone + sDone;
    return {
      done,
      total,
      fracLabel: `${bDone} / ${b.length} · ${sDone} / ${s.length}`,
      frac: total > 0 ? done / total : 0,
    };
  }
  const steps = stepsFor(e, e.side === 'sell' ? 'seller' : 'buyer');
  const done = countDone(steps);
  return {
    done,
    total: steps.length,
    fracLabel: `${done} / ${steps.length} steps`,
    frac: steps.length > 0 ? done / steps.length : 0,
  };
}

/**
 * Invited-card progress (Team Access): full escrows carry their step
 * arrays and reuse cardBits; summary-shaped rows (list_invited_escrows)
 * fall back to stamped counts when present.
 */
function invitedCardBits(e: Escrow): CardBits {
  if (Array.isArray(e.buyerSteps) && Array.isArray(e.sellerSteps)) {
    return cardBits(e);
  }
  const raw = e as unknown as Record<string, unknown>;
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const done = num(raw.stepsDone ?? raw.doneCount ?? raw.completedSteps);
  const total = num(raw.stepsTotal ?? raw.totalCount ?? raw.totalSteps);
  if (total > 0) {
    return { done, total, fracLabel: `${done} / ${total} steps`, frac: done / total };
  }
  return { done: 0, total: 0, fracLabel: '', frac: 0 };
}

function daysUntil(closeDate: string): number {  // Same convention as every other surface: whole calendar days, DST-safe.
  try {
    return daysToClose(closeDate);
  } catch {
    return 0;
  }
}

interface ChipBits {
  chip: string;
  chipUrgent: boolean;
  chipClosed: boolean;
}

function chipBits(e: Escrow): ChipBits {
  if (isClosedRow(e)) {
    const d = closedDisplayDate(e);
    return {
      chip: d ? `Closed ${formatShortDate(d)}` : 'Closed',
      chipUrgent: false,
      chipClosed: true,
    };
  }
  const left = daysUntil(e.closeDate);
  if (left < 0) {
    return { chip: 'Past target date', chipUrgent: true, chipClosed: false };
  }
  const label = `${left} ${left === 1 ? 'day' : 'days'} to close`;
  return { chip: label, chipUrgent: left <= 10, chipClosed: false };
}

/** Deal-list section headers use the shared SectionHeader component
 * (src/components/SectionHeader.tsx): bordered dropdown-style card,
 * 52px min-height, proper up/down chevrons. */

export default function DealList() {
  const router = useRouter();
  // iOS (Sept 2026): the top of the screen sat under the status bar on
  // native, so the header crowded the notch. The safe-area gap (inset +
  // the deliberate 14) sits above the banner strip, which starts below it.
  const insets = useSafeAreaInsets();
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  // Team Access (Oct 20, 2026): escrows other realtors shared with me,
  // and team invites waiting on my answer (frames 1/2/4).
  const [invitedEscrows, setInvitedEscrows] = useState<Escrow[]>([]);
  const [pendingInvites, setPendingInvites] = useState<TeamPendingInvite[]>([]);
  const [invitedOpen, setInvitedOpen] = useState(true);
  const [respondingId, setRespondingId] = useState<string | null>(null);
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [profileIncomplete, setProfileIncomplete] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  // Deal-list edit round (Sept 2026): the escrow being edited, the escrow
  // awaiting cancel confirmation, toast state, and the Cancelled section's
  // collapsed state (collapsed by default; auto-expands on cancel).
  const [editing, setEditing] = useState<Escrow | null>(null);
  const [cancelling, setCancelling] = useState<Escrow | null>(null);
  const [cancelledOpen, setCancelledOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  };

  // Collapsible deal-list sections (mockup 01 · ①): Active starts expanded,
  // Closed starts collapsed.
  const [activeOpen, setActiveOpen] = useState(true);
  const [closedOpen, setClosedOpen] = useState(false);

  const load = useCallback(async () => {
    let all: Escrow[] = [];
    try {
      all = await store.listEscrows();
      setEscrows(all);
    } catch (err) {
      console.warn('listEscrows failed', err);
    }
    // Team Access (Oct 20, 2026): pending invites + escrows shared with
    // me. refreshTeam merges invited escrows into the store's escrow
    // cache, so the list is re-read after it runs; the split is by the
    // stamped access role. Team state is additive — any failure leaves
    // the own-escrow list exactly as it was. (`all` above is the
    // pre-refresh read, kept as the fallback.)
    try {
      await store.refreshTeam();
      setPendingInvites(store.pendingTeamInvites ?? []);
      const fresh = await store.listEscrows();
      setEscrows(fresh);
      setInvitedEscrows(fresh.filter((e) => accessRoleOf(e) !== 'owner'));
    } catch (err) {
      console.warn('refreshTeam failed', err);
      setInvitedEscrows(all.filter((e) => accessRoleOf(e) !== 'owner'));
    }
    try {
      const [p, skipped] = await Promise.all([
        store.getProfile(),
        auth.getProfileSkipped(),
      ]);
      setProfile(p);
      // "Complete your profile" shows only when profile creation was
      // explicitly skipped during sign-up (approved mockup 24) — never
      // merely because no local profile row exists yet.
      setProfileIncomplete(shouldShowProfileNudge({ skipped }));
    } catch {
      // Profile is decorative here; the list still renders.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Team Access: escrows carries my own escrows; anything stamped with a
  // member access role is split out so the own sections and the header
  // counts stay own-only (frames 1/2).
  const ownEscrows = escrows.filter((e) => accessRoleOf(e) === 'owner');
  const open = ownEscrows
    // Neither a closed row (lifecycle per-side semantics) nor cancelled —
    // cancelled escrows have their own section.
    .filter((e) => e.status !== 'cancelled' && !isClosedRow(e))
    .sort((a, b) => a.closeDate.localeCompare(b.closeDate));
  const closed = ownEscrows
    .filter((e) => isClosedRow(e))
    .sort((a, b) => b.closeDate.localeCompare(a.closeDate));
  const cancelled = ownEscrows
    .filter((e) => e.status === 'cancelled')
    .sort((a, b) => b.closeDate.localeCompare(a.closeDate));

  const renderDeal = (e: Escrow) => {
    const bits = cardBits(e);
    const chip = chipBits(e);
    return (
      <View key={e.id} style={styles.dealWrap}>
        <DealCard
          escrowId={e.id}
          address={e.address}
          partyLine={partyLine(e)}
          side={e.side}
          chip={chip.chip}
          chipUrgent={chip.chipUrgent}
          chipClosed={chip.chipClosed}
          cancelled={e.status === 'cancelled'}
          fracLabel={bits.fracLabel}
          frac={bits.frac}
          onPress={() => router.push(`/escrow/${e.id}`)}
          onEdit={() => setEditing(e)}
          // Closed and cancelled cards show the pencil only — no X.
          onCancel={e.status === 'open' ? () => setCancelling(e) : null}
        />
      </View>
    );
  };

  const countLine =
    `${open.length} open · ${closed.length} closed` +
    (cancelled.length > 0 ? ` · ${cancelled.length} cancelled` : '');

  // ---- Team Access: pending invites + invited deal cards (frames 1/2/4) ----

  const respondToInvite = async (inv: TeamPendingInvite, accept: boolean) => {
    if (respondingId) return;
    setRespondingId(inv.grantId);
    try {
      await store.respondToTeamInvite(inv.grantId, accept);
      await load();
      showToast(accept ? 'Invite accepted.' : 'Invite rejected.');
    } catch (err) {
      console.warn('respondToTeamInvite failed', err);
      showToast("Couldn't save your answer. Try again.");
    } finally {
      setRespondingId(null);
    }
  };

  const renderPendingInvite = (inv: TeamPendingInvite) => {
    const e = inv.escrow;
    const party =
      e.side === 'both'
        ? `Buyer: ${e.buyerName ?? ''} · Seller: ${e.sellerName ?? ''}`
        : e.side === 'sell'
          ? `Seller: ${e.sellerName ?? ''}`
          : `Buyer: ${e.buyerName ?? ''}`;
    const busy = respondingId === inv.grantId;
    const ownerLabel = inv.ownerName?.trim() || 'A realtor';
    return (
      <View key={inv.grantId} style={styles.dealWrap}>
        <Card style={styles.inviteCard} testID={`pending-invite-${inv.grantId}`}>
          <Text style={styles.inviteWho}>
            {ownerLabel} invited you to join an escrow as{' '}
            <Text style={styles.inviteWhoBold}>{teamRoleSeatTitle(inv.role)}</Text>
          </Text>
          <Text style={styles.inviteSub}>
            {e.address} · {party}
          </Text>
          <Text style={styles.inviteSub}>{pendingInviteAbilityLine(inv.role)}</Text>
          <View style={styles.inviteBtns}>
            <View style={styles.inviteBtnHalf}>
              <PrimaryButton
                title={busy ? 'Saving…' : 'Accept'}
                onPress={() => respondToInvite(inv, true)}
                disabled={busy}
              />
            </View>
            <Pressable
              onPress={() => respondToInvite(inv, false)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Reject the invite from ${ownerLabel}`}
              style={({ pressed }) => [
                styles.declineBtn,
                (pressed || busy) && { opacity: 0.6 },
              ]}
            >
              <Text style={styles.declineText}>Reject</Text>
            </Pressable>
          </View>
        </Card>
      </View>
    );
  };

  const renderInvitedDeal = (e: Escrow) => {
    const bits = invitedCardBits(e);
    const chip = chipBits(e);
    const role = accessRoleOf(e);
    const owner = ownerNameOf(e);
    const chipFg = chip.chipClosed ? colors.sage : chip.chipUrgent ? colors.amber : colors.accent;
    const chipBg = chip.chipClosed
      ? colors.sageSoft
      : chip.chipUrgent
        ? colors.amberSoft
        : colors.accentSoft;
    return (
      <View key={e.id} style={styles.dealWrap}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${e.address}, shared by ${owner}`}
          onPress={() => router.push(`/escrow/${e.id}`)}
          testID={`invited-deal-${e.id}`}
          style={({ pressed }) => [pressed && { transform: [{ scale: 0.99 }] }]}
        >
          <Card style={styles.invitedCardBorder}>
            <View style={styles.invitedSideRow}>
              <View
                style={[
                  styles.invitedSidePill,
                  { backgroundColor: INVITED_SIDE_BG[e.side] },
                ]}
              >
                <Text
                  style={[
                    styles.invitedSidePillText,
                    { color: INVITED_SIDE_FG[e.side] },
                  ]}
                >
                  {INVITED_SIDE_LABEL[e.side]}
                </Text>
              </View>
            </View>
            <Text style={styles.invitedAddr} numberOfLines={2}>
              {e.address}
            </Text>
            <Text style={styles.invitedParty} numberOfLines={1}>
              {partyLine(e)}
            </Text>
            <View style={styles.ownerRow}>
              <View style={styles.ownerAvatar}>
                <Text style={styles.ownerAvatarText}>{initialsOf(owner || '?')}</Text>
              </View>
              <Text style={styles.ownerName} numberOfLines={1}>
                {owner ? `${owner}'s escrow` : 'Shared escrow'}
              </Text>
              <View
                style={[
                  styles.rolePill,
                  role === 'tc' ? styles.rolePillTc : styles.rolePillAssoc,
                ]}
              >
                <Text
                  style={[
                    styles.rolePillText,
                    role === 'tc' ? styles.rolePillTextTc : styles.rolePillTextAssoc,
                  ]}
                >
                  {role === 'tc' ? 'TC' : 'Associate'}
                </Text>
              </View>
            </View>
            <View style={styles.invitedMeta}>
              <View style={[styles.invitedChip, { backgroundColor: chipBg }]}>
                <Text style={[styles.invitedChipText, { color: chipFg }]}>
                  {chip.chip}
                </Text>
              </View>
              <Text style={styles.invitedFrac}>{bits.fracLabel}</Text>
            </View>
            <View style={styles.invitedBar}>
              <View
                style={[
                  styles.invitedFill,
                  { width: `${Math.min(Math.max(bits.frac * 100, 0), 100)}%` },
                ]}
              />
            </View>
          </Card>
        </Pressable>
      </View>
    );
  };

  const firstName = (profile?.name ?? '').trim().split(/\s+/)[0] ?? '';

  return (
    <View style={styles.wrap}>
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {/* Safe-area gap sits ABOVE the banner (header-top-gap release, Sept
          2026): the banner must never crowd the status bar. */}
      <View style={[styles.topSpace, { height: insets.top + 14 }]} />
      {/* Banner section (approved sample, Anuraj, Sept 2026): full-bleed
          118px strip above the existing header — the realtor's synced
          banner, cover-cropped, with the brand-teal gradient fallback. The
          photo sits on the banner's right side and opens the profile page
          exactly as the old header avatar did. */}
      <View style={styles.bannerWrap}>
        <BannerStrip
          name={profile?.name ?? ''}
          bannerUri={displayBannerUri(profile)}
          photoUri={displayPhotoUri(profile)}
          bannerHeight={TOPCARD_TOKENS.large.banner}
          photoSize={TOPCARD_TOKENS.large.photo}
          photoRight={TOPCARD_TOKENS.large.photoRight}
          photoBorder={TOPCARD_TOKENS.large.photoBorder}
          initialsSize={TOPCARD_TOKENS.large.photoInitials}
          onPhotoPress={() => router.push('/profile-update')}
          photoAccessibilityLabel="Your profile"
          stripTestID="home-banner-strip"
          bannerTestID="home-banner"
          gradientTestID="home-banner-gradient"
          photoTestID="home-banner-photo"
        />
      </View>
      <View style={styles.headRow}>
        <View>
          {/* "Hi {realtor name}" replaces the REALTOR kicker (mockup 01 · ①). */}
          <Kicker>{firstName ? `Hi ${firstName}` : 'Hi there'}</Kicker>
          <Text style={styles.h2}>Escrows</Text>
        </View>
      </View>
      <Text style={styles.count}>{countLine}</Text>

      {ownEscrows.length === 0 && invitedEscrows.length === 0 && pendingInvites.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyKicker}>Get started</Text>
          <Text style={styles.emptyTitle}>No escrows yet</Text>
          <Text style={styles.emptyText}>
            Open your first escrow to start tracking it. Your buyer or seller
            can follow along from their phone.
          </Text>
          <PrimaryButton title="+ New escrow" onPress={() => setSheetVisible(true)} />
          {profileIncomplete ? (
            <Pressable
              onPress={() => router.push('/profile-update')}
              hitSlop={8}
              style={styles.completeProfileWrap}
            >
              <Text style={styles.completeProfile}>Complete your profile →</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          {ownEscrows.length > 0 ? (
            <>
              {/* "+ New escrow" sits above the sections (mockup 01 · ①). */}
              <View style={styles.newBtnWrap}>
                <PrimaryButton title="+ New escrow" onPress={() => setSheetVisible(true)} />
              </View>
              <Text style={styles.groupLabel}>Your escrows</Text>
              <SectionHeader
                title="Active escrows"
                count={open.length}
                expanded={activeOpen}
                onToggle={() => setActiveOpen((v) => !v)}
                testID="section-active"
              />
              {activeOpen && open.map(renderDeal)}
              {closed.length > 0 && (
                <>
                  <SectionHeader
                    title="Closed escrows"
                    count={closed.length}
                    expanded={closedOpen}
                    onToggle={() => setClosedOpen((v) => !v)}
                    testID="section-closed"
                  />
                  {closedOpen && closed.map(renderDeal)}
                </>
              )}
              {cancelled.length > 0 && (
                <View style={styles.cancelledSection}>
                  <SectionHeader
                    title="Cancelled escrows"
                    count={cancelled.length}
                    expanded={cancelledOpen}
                    onToggle={() => setCancelledOpen((v) => !v)}
                    testID="section-cancelled"
                  />
                  {cancelledOpen && cancelled.map(renderDeal)}
                </View>
              )}
            </>
          ) : (
            <>
              {/* Frame 2: with no escrows of their own, "Your escrows"
                  collapses to a slim starter card so the invited work is
                  front and center. */}
              <Text style={styles.groupLabel}>Your escrows</Text>
              <Card style={styles.starterCard}>
                <Text style={styles.starterTitle}>No escrows of your own yet</Text>
                <Text style={styles.starterText}>
                  Escrows you open yourself will live here.
                </Text>
              </Card>
              <View style={styles.newBtnWrap}>
                <PrimaryButton title="+ New escrow" onPress={() => setSheetVisible(true)} />
              </View>
              {profileIncomplete ? (
                <Pressable
                  onPress={() => router.push('/profile-update')}
                  hitSlop={8}
                  style={styles.completeProfileWrap}
                >
                  <Text style={styles.completeProfile}>Complete your profile →</Text>
                </Pressable>
              ) : null}
            </>
          )}

          {/* Team Access (frames 1/2/4): the Invited escrows group sits
              below Your escrows — pending invites first, then the
              "Shared with you" cards. The section ALWAYS renders
              (Oct 22, 2026): empty shows the "No invites yet." line. */}
          <>
            <Text style={styles.groupLabel}>Invited escrows</Text>
            {pendingInvites.map(renderPendingInvite)}
            {invitedEscrows.length > 0 && (
              <>
                <SectionHeader
                  title="Shared with you"
                  count={invitedEscrows.length}
                  expanded={invitedOpen}
                  onToggle={() => setInvitedOpen((v) => !v)}
                  testID="section-invited"
                />
                {invitedOpen && invitedEscrows.map(renderInvitedDeal)}
              </>
            )}
            {pendingInvites.length === 0 && invitedEscrows.length === 0 && (
              <Text style={styles.emptyText}>No invites yet.</Text>
            )}
          </>
        </>
      )}

      <NewEscrowSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        onCreated={(id) => {
          setSheetVisible(false);
          router.push(`/escrow/${id}`);
        }}
      />

      <UpdateEscrowSheet
        escrow={editing}
        onClose={() => setEditing(null)}
        onSaved={(updated) => {
          // Activate escrow (Sept 2026): a closed/cancelled escrow edited
          // through the sheet comes back open — name the move in the toast.
          const reactivated =
            !!editing && editing.status !== 'open' && updated.status === 'open';
          setEditing(null);
          if (updated.status === 'cancelled') {
            // Cancelled via the sheet's danger action: reveal the move.
            setCancelledOpen(true);
          } else {
            showToast(reactivated ? 'Escrow activated.' : 'Escrow updated.');
          }
          load();
        }}
      />

      <CancelEscrowSheet
        escrow={cancelling}
        onClose={() => setCancelling(null)}
        onCancelled={() => {
          setCancelling(null);
          setCancelledOpen(true);
          load();
        }}
      />

      </ScrollView>

      {/* Toast sits above the scroll view so it never scrolls away. */}
      {toastMsg && (
        <View style={styles.toast} testID="toast">
          <Text style={styles.toastText}>{toastMsg}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  screen: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  content: {
    padding: 18,
    paddingBottom: 40,
  },
  headRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginTop: 14,
    marginBottom: 4,
  },
  // Safe-area gap above the banner (header-top-gap release): breaks out of
  // the content padding so it spans the full screen width.
  topSpace: {
    marginTop: -18,
    marginHorizontal: -18,
  },
  // Full-bleed banner strip above the header (approved sample, Anuraj,
  // Sept 2026): breaks out of the content's 18px padding edge to edge.
  bannerWrap: {
    marginHorizontal: -18,
  },
  h2: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 2,
  },
  count: {
    fontSize: 13,
    color: colors.muted,
    marginBottom: 14,
  },
  dealWrap: {
    marginBottom: 14,
  },
  newBtnWrap: {
    marginTop: 2,
    marginBottom: 14,
  },
  cancelledSection: {
    marginTop: 22,
  },
  // Team Access group label (frames 1/2/4): small-caps muted label above
  // each home group ("Your escrows" / "Invited escrows").
  groupLabel: {
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
    color: colors.muted,
    marginTop: 6,
    marginBottom: 10,
    marginHorizontal: 2,
  },
  starterCard: {
    padding: 16,
    marginBottom: 14,
  },
  starterTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
  },
  starterText: {
    fontSize: 13.5,
    color: colors.body,
    marginTop: 3,
    lineHeight: 19,
  },
  // Pending team invite card (frame 4): gold-bordered card on a warm tint.
  inviteCard: {
    borderWidth: 1.5,
    borderColor: colors.gold,
    backgroundColor: '#FFFDF6',
    padding: 16,
  },
  inviteWho: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.ink,
    lineHeight: 21,
  },
  inviteWhoBold: {
    fontWeight: '800',
    color: colors.ink,
  },
  inviteSub: {
    fontSize: 13.5,
    color: colors.body,
    marginTop: 3,
    lineHeight: 19,
  },
  inviteBtns: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
  },
  inviteBtnHalf: {
    flex: 1,
  },
  declineBtn: {
    flex: 1,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  declineText: {
    color: colors.body,
    fontSize: 16,
    fontWeight: '700',
  },
  // Invited deal card (frames 1/2): DealCard layout + the owner row.
  invitedCardBorder: {
    borderWidth: 1,
    borderColor: 'rgba(231,224,211,0.7)',
  },
  invitedSideRow: {
    alignItems: 'flex-start',
    marginBottom: 6,
  },
  invitedSidePill: {
    flexShrink: 0,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 9,
  },
  invitedSidePillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  invitedAddr: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink,
    marginBottom: 2,
  },
  invitedParty: {
    fontSize: 13.5,
    color: colors.muted,
  },
  ownerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 9,
    marginBottom: 12,
  },
  ownerAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  ownerAvatarText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  ownerName: {
    flex: 1,
    fontSize: 13,
    color: colors.body,
    fontWeight: '600',
  },
  rolePill: {
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 9,
    flexShrink: 0,
  },
  rolePillAssoc: {
    backgroundColor: colors.accentSoft,
  },
  rolePillTc: {
    backgroundColor: colors.amberSoft,
  },
  rolePillText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
  },
  rolePillTextAssoc: {
    color: colors.accent,
  },
  rolePillTextTc: {
    color: colors.amber,
  },
  invitedMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 10,
  },
  invitedChip: {
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 11,
  },
  invitedChipText: {
    fontSize: 12.5,
    fontWeight: '700',
  },
  invitedFrac: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.body,
  },
  invitedBar: {
    height: 7,
    borderRadius: 99,
    backgroundColor: colors.line,
    overflow: 'hidden',
  },
  invitedFill: {
    height: '100%',
    borderRadius: 99,
    backgroundColor: colors.accent,
  },
  empty: {
    marginTop: 56,
    alignItems: 'stretch',
    paddingHorizontal: 8,
  },
  emptyKicker: {
    fontSize: 12,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
    color: colors.accent,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.ink,
    textAlign: 'center',
    marginTop: 6,
  },
  emptyText: {
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.body,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 20,
  },
  completeProfileWrap: {
    marginTop: 18,
    alignSelf: 'center',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  completeProfile: {
    fontSize: 15,
    color: colors.accent,
    fontWeight: '700',
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
