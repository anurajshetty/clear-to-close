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
import { Kicker, PrimaryButton } from '../src/components/ui';
import NewEscrowSheet from '../src/components/NewEscrowSheet';
import UpdateEscrowSheet from '../src/components/UpdateEscrowSheet';
import CancelEscrowSheet from '../src/components/CancelEscrowSheet';
import { colors } from '../src/theme';

export type Role = ClientRole;

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

function daysUntil(closeDate: string): number {
  // Same convention as every other surface: whole calendar days, DST-safe.
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
    try {
      setEscrows(await store.listEscrows());
    } catch (err) {
      console.warn('listEscrows failed', err);
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

  const open = escrows
    // Neither a closed row (lifecycle per-side semantics) nor cancelled —
    // cancelled escrows have their own section.
    .filter((e) => e.status !== 'cancelled' && !isClosedRow(e))
    .sort((a, b) => a.closeDate.localeCompare(b.closeDate));
  const closed = escrows
    .filter((e) => isClosedRow(e))
    .sort((a, b) => b.closeDate.localeCompare(a.closeDate));
  const cancelled = escrows
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

      {escrows.length === 0 ? (
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
          {/* "+ New escrow" sits above the sections (mockup 01 · ①). */}
          <View style={styles.newBtnWrap}>
            <PrimaryButton title="+ New escrow" onPress={() => setSheetVisible(true)} />
          </View>
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
          setEditing(null);
          if (updated.status === 'cancelled') {
            // Cancelled via the sheet's danger action: reveal the move.
            setCancelledOpen(true);
          } else {
            showToast('Escrow updated.');
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
