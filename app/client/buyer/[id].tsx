// Clear to Close — buyer home view (read-only).
// Faithful to APPROVED mockup 01 · device 4 (+ device 11 live-update details),
// reworked Sept 26 (branding): the client top card (see ClientTopCard) is a
// full-bleed banner — the realtor's banner photo behind everything (brand-teal
// gradient fallback) with a dark scrim; bold "Hi {name}" greeting,
// "Your transaction" kicker + non-bold address, the realtor's avatar circle
// top-right at the greeting level (tap -> Call/Text menu); centered below:
// "N of N steps" above the 208px gold progress ring, then the days-left line
// ("days left: N" / "due today" / "overdue by N day(s)"). Status tag next to
// the kicker: "In progress" or "Completed" (escrow status, migration 0015).
// At 100% the top card stays the same card (status flips to "Completed",
// confetti burst pops up from below it), followed by the review/share
// section (100% and not cancelled). No pace pill, no completion pill, no
// separate 100% triumph card (Anuraj, Sept 2026). The single ordered checklist
// in the realtor's order sits below — checked steps stay in place, UP NEXT on the first
// remaining step, no tap targets, no drag grips, no Custom tag, no JUST NOW
// markers. The standalone realtor card is removed (Sept 25).
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { store } from '../../../src/lib/store-instance';
import { auth } from '../../../src/lib/auth';
import { useClientLinkGate } from '../../../src/hooks/useClientLinkGate';
import { useReviewSheet } from '../../../src/hooks/useReviewSheet';
import type { ClientView, RealtorProfile } from '../../../src/lib/types';
import { SecondaryButton } from '../../../src/components/ui';
import { ClientTopCard } from '../../../src/components/ClientTopCard';
import { LatestFromCard } from '../../../src/components/LatestFromCard';
import { ClientTriumphSection } from '../../../src/components/ClientTriumph';
import { canLeaveReview, REVIEWS_ENABLED } from '../../../src/lib/clientView';
import { ReviewSheet } from '../../../src/components/ReviewSheet';
import { ReadOnlyChecklist } from '../../../src/components/Checklist';
import { colors } from '../../../src/theme';

export default function BuyerView() {
  const router = useRouter();
  // iOS (Sept 2026): top content crowded the status bar — clear the
  // safe-area inset plus the existing gap (10).
  const insets = useSafeAreaInsets();
  const raw = useLocalSearchParams().id;
  const id = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  const [view, setView] = useState<ClientView | null>(null);
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [partyName, setPartyName] = useState('');
  // Data load, shared by focus and foreground (Sept 2026
  // foreground-refresh fix): the focus effect does not fire on foreground
  // return, so the link gate invokes this to converge the view and the
  // linked realtor profile instead of leaving the stale snapshot rendered.
  const load = useCallback(() => {
    let active = true;
    if (id) {
      store
        .getBuyerView(id)
        .then(async (v) => {
          if (active) setView(v);
          // The fresh cloud view carries the linked realtor profile — pick
          // it up after the view lands so the top card always shows the
          // latest synced photo (Sept 2026: the old two-call pattern below
          // let the fast local getProfile() (null on client devices)
          // overwrite the linked profile in a race).
          try {
            const linked = await store.getLinkedProfile(id);
            if (active && linked) setProfile(linked);
          } catch {}
        })
        .catch(() => {});
    }
    // Linked-first, local fallback — a single call, no race (the same
    // pattern the redeem celebration screen uses).
    store
      .getClientProfile(id || null)
      .then((p) => {
        if (active && p) setProfile(p);
      })
      .catch(() => {});
    // The greeting uses the name from this device's link (what the buyer
    // entered at redeem).
    auth
      .getClientLink()
      .then((link) => {
        if (active && link && link.escrowId === id) setPartyName(link.partyName);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);
  // The device link is revalidated on every focus, BEFORE the escrow
  // renders — a revoked/superseded link routes to /link-dead.
  const { gateState, retry } = useClientLinkGate(id, 'buyer', {
    onForegroundRefresh: load,
  });
  // 100% triumph "Leave a review" -> the profile stream's review sheet.
  const review = useReviewSheet(view, profile, setProfile, setView);

  useFocusEffect(load);

  const greeting = partyName.trim() ? `Hi ${partyName.trim()}` : 'Hi there';
  // Review gate (Anuraj's rule, Sept 2026): the triumph review/share section
  // shows only at 100% on a non-cancelled escrow — a cancelled escrow never
  // shows the review button, even if its checklist is complete. (The top
  // card computes its own 100% state from done/total.)
  // The review feature is ON HOLD (Anuraj, Sept 2026): the section is
  // additionally gated on REVIEWS_ENABLED, so no review/share UI is surfaced
  // while the flag is false. The gate, the sheet, and the section stay wired.
  const showTriumphActions = view != null && canLeaveReview(view);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 10 }]}>
      {gateState === 'checking' ? (
        <Text style={styles.loading}>Loading…</Text>
      ) : gateState === 'error' ? (
        <View style={styles.gateError}>
          <Text style={styles.gateErrorText}>
            Couldn&apos;t verify your invite link. Check your connection and try again.
          </Text>
          <SecondaryButton title="Try again" onPress={retry} />
        </View>
      ) : !view ? (
        <Text style={styles.loading}>Loading…</Text>
      ) : (
        <>
          <ClientTopCard
            greeting={greeting}
            kicker="Your transaction"
            address={view.address}
            city={view.city}
            daysToClose={view.daysToClose}
            done={view.done}
            total={view.total}
            profile={profile}
            status={view.status}
            openDate={view.openDate}
            closeDate={view.closeDate}
            // The banner photo opens the IN-APP realtor profile (never the
            // public /realtor/<id> page) — the shared celebration wiring via
            // the escrow id. (Sept 2026: photo taps were misrouted to the
            // public page, which is how the old three-stat white box showed.)
            onProfilePress={() =>
              router.push({ pathname: '/realtor-profile', params: { escrowId: id } })
            }
          />

          {/* "LATEST FROM {NAME}" (mockup screen 7): directly below the top
              card, above the checklist, in every state — always visible. */}
          <LatestFromCard
            lastAction={view.lastAction}
            steps={view.steps}
            realtorName={profile?.name ?? ''}
            openedAt={view.openedAt}
            openDate={view.openDate}
          />

          {showTriumphActions && REVIEWS_ENABLED ? (
            <ClientTriumphSection
              steps={view.steps}
              profile={profile}
              clientName={partyName}
              daysToClose={view.daysToClose}
              realtorId={view.realtorId}
              onLeaveReviewPress={review.openSheet}
            />
          ) : (
            <>
              <ReadOnlyChecklist steps={view.steps} />

              <Text style={styles.note}>
                Updated by your realtor.{'\n'}This view is read-only.
              </Text>
            </>
          )}
        </>
      )}
      <ReviewSheet
        visible={review.open}
        realtorName={profile?.name ?? ''}
        realtorPhotoUri={profile?.photoUri ?? null}
        existingReview={review.existingReview}
        busy={review.busy}
        error={review.error}
        onSubmit={review.submit}
        onDelete={review.remove}
        onClose={review.closeSheet}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  content: {
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 40,
  },
  loading: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 40,
  },
  gateError: {
    marginTop: 48,
    alignItems: 'stretch',
    paddingHorizontal: 8,
  },
  gateErrorText: {
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.body,
    textAlign: 'center',
    marginBottom: 18,
  },
  note: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 18.75,
    marginTop: 22,
  },
});
