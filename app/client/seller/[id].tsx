// Clear to Close — seller home view (read-only).
// Faithful to APPROVED mockup 01 · device 14 (+ device 11 live-update details),
// reworked Sept 26 (branding): the client top card (see ClientTopCard) is a
// full-bleed banner — the realtor's banner photo behind everything (brand-teal
// gradient fallback) with a dark scrim; bold "Hi {name}" greeting,
// "Your sale" kicker + non-bold address, the realtor's avatar circle
// top-right at the greeting level (tap -> Call/Text menu); centered below:
// "N of N steps" above the 208px gold progress ring, then the days-left line
// ("days left: N" / "due today" / "overdue by N day(s)"). Status pill: 100% +
// 5+ days left -> "Checklist complete with {N} days to spare. {Name} has you
// ahead of schedule."; 100% with fewer -> "Congratulations, your checklist is
// complete"; 15+ points ahead of the timeline -> gold "Ahead of pace" pill.
// A "GUIDED BY" strip (photo, name, tagline, Call/Text/Profile) anchors the
// card. The single ordered checklist in the realtor's order sits below —
// checked steps stay in place, UP NEXT on the first remaining step, no tap
// targets, no drag grips, no Custom tag, no JUST NOW markers. The standalone
// realtor card is removed (Sept 25).
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { store } from '../../../src/lib/store-instance';
import { auth } from '../../../src/lib/auth';
import { useClientLinkGate } from '../../../src/hooks/useClientLinkGate';
import { useReviewSheet } from '../../../src/hooks/useReviewSheet';
import type { ClientView, RealtorProfile } from '../../../src/lib/types';
import { SecondaryButton } from '../../../src/components/ui';
import { ClientTopCard } from '../../../src/components/ClientTopCard';
import { LatestFromCard } from '../../../src/components/LatestFromCard';
import { ClientTriumphSection } from '../../../src/components/ClientTriumph';
import { ReviewSheet } from '../../../src/components/ReviewSheet';
import { ReadOnlyChecklist } from '../../../src/components/Checklist';
import { colors } from '../../../src/theme';

export default function SellerView() {
  const router = useRouter();
  const raw = useLocalSearchParams().id;
  const id = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  const [view, setView] = useState<ClientView | null>(null);
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [partyName, setPartyName] = useState('');
  // The device link is revalidated on every focus, BEFORE the escrow
  // renders — a revoked/superseded link routes to /link-dead.
  const { gateState, retry } = useClientLinkGate(id, 'seller');
  // 100% triumph "Leave a review" -> the profile stream's review sheet.
  const review = useReviewSheet(view, profile, setProfile, setView);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (id) {
        store
          .getSellerView(id)
          .then((v) => {
            if (active) setView(v);
          })
          .catch(() => {});
      }
      store
        .getProfile()
        .then((p) => {
          if (active) setProfile(p);
        })
        .catch(() => {});
      // Cloud-linked realtor profile when this view came through an invite;
      // falls back to the local realtor profile.
      if (id) {
        store
          .getLinkedProfile(id)
          .then((linked) => {
            if (active && linked) setProfile(linked);
          })
          .catch(() => {});
      }
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
    }, [id]),
  );

  const greeting = partyName.trim() ? `Hi ${partyName.trim()}` : 'Hi there';
  // 100%: the top card becomes the realtor triumph and the body below it
  // becomes the collapsed checklist + review/share section (screen 10).
  const isComplete = view != null && view.total > 0 && view.done >= view.total;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
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
            kicker="Your sale"
            address={view.address}
            city={view.city}
            daysToClose={view.daysToClose}
            done={view.done}
            total={view.total}
            openDate={view.openDate}
            closeDate={view.closeDate}
            profile={profile}
            onProfilePress={() =>
              view?.realtorId
                ? router.push(`/realtor/${view.realtorId}`)
                : router.push({ pathname: '/client/profile', params: { escrowId: id } })
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

          {isComplete ? (
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
