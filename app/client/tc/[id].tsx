// Clear to Close — transaction coordinator home view (read-only).
// Sept 2026 (Anuraj's decision): on a "both" escrow the TC sees BOTH
// checklists; on a single-side escrow the active side's. Reuses the same
// ClientTopCard + ReadOnlyChecklist as the buyer/seller views — no
// divergent copies. Same read-only rules: no tap targets, no drag grips,
// no Custom tag, no JUST NOW markers.
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { store } from '../../../src/lib/store-instance';
import { auth } from '../../../src/lib/auth';
import { useClientLinkGate } from '../../../src/hooks/useClientLinkGate';
import { useClientRealtime } from '../../../src/hooks/useClientRealtime';
import type { ClientView, RealtorProfile, TcView } from '../../../src/lib/types';
import { Kicker, SecondaryButton } from '../../../src/components/ui';
import { MyEscrowsBack, JoinAnotherEscrow } from '../../../src/components/EscrowSwitcher';
import { ClientTopCard } from '../../../src/components/ClientTopCard';
import { LatestFromCard } from '../../../src/components/LatestFromCard';
import { KeyDatesEntryPoint, KeyDatesSheet } from '../../../src/components/KeyDates';
import { ReadOnlyChecklist } from '../../../src/components/Checklist';
import { TcEntryCard } from '../../../src/components/TcIntakeEntry';
import { showTcDetailsForTcView } from '../../../src/lib/tcIntake';
import { mostRecentAction } from '../../../src/lib/latest';
import { colors } from '../../../src/theme';

function SideSection({ title, view }: { title: string; view: ClientView }) {
  return (
    <View style={styles.section}>
      <Kicker>{title}</Kicker>
      <Text style={styles.sectionCap} testID={`tc-${view.role}-caption`}>
        {`${view.done} of ${view.total} steps`}
      </Text>
      <ReadOnlyChecklist steps={view.steps} role={view.role} />
    </View>
  );
}

export default function TcView() {
  const router = useRouter();
  // iOS (Sept 2026): top content crowded the status bar — clear the
  // safe-area inset plus the existing gap (10).
  const insets = useSafeAreaInsets();
  const raw = useLocalSearchParams().id;
  const id = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  const [view, setView] = useState<TcView | null>(null);
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [partyName, setPartyName] = useState('');
  // "KEY DATES" sheet (Sept 28, 2026 amendment): entry point opens it.
  const [keyDatesOpen, setKeyDatesOpen] = useState(false);
  // Data load, shared by focus and foreground (Sept 2026
  // foreground-refresh fix): the focus effect does not fire on foreground
  // return, so the link gate invokes this to converge the view and the
  // linked realtor profile instead of leaving the stale snapshot rendered.
  const load = useCallback(() => {
    let active = true;
    if (id) {
      store
        .getTcView(id)
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
    // The greeting uses the name from this device's link (what the
    // coordinator entered at redeem).
    auth
      .getClientLinkForEscrow(id ?? '')
      .then((link) => {
        if (active && link) setPartyName(link.partyName);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [id]);
  // The device link is revalidated on every focus, BEFORE the escrow
  // renders — a revoked/superseded link routes to /link-dead.
  const { gateState, retry } = useClientLinkGate(id, 'tc', {
    onForegroundRefresh: load,
  });
  // Secure realtime (Sept 2026): once the gate validates the link, live
  // server events re-pull this view; any failure degrades silently to the
  // focus/foreground refetch above.
  useClientRealtime(id, { enabled: gateState === 'valid', onDataChanged: load });

  useFocusEffect(load);

  const greeting = partyName.trim() ? `Hi ${partyName.trim()}` : 'Hi there';
  const done = (view?.buyer?.done ?? 0) + (view?.seller?.done ?? 0);
  const total = (view?.buyer?.total ?? 0) + (view?.seller?.total ?? 0);
  // "LATEST FROM {NAME}" (mockup screens ④/⑤/⑪/⑭, shared component): the
  // most recent realtor action across BOTH sides wins. Single-side escrows
  // just carry one side; when neither side has activity the card falls
  // back to "{Name} opened your escrow".
  const tcLastAction = view ? mostRecentAction([view.buyer?.lastAction, view.seller?.lastAction]) : null;
  const tcSteps = view ? [...(view.buyer?.steps ?? []), ...(view.seller?.steps ?? [])] : [];
  // Key dates (and their alert-hint step mapping) come from the same side
  // as the dates: buyer wins when present, else the seller side.
  const keyDateSide = view?.buyer ?? view?.seller ?? null;
  const keyDateRole: 'buyer' | 'seller' = view?.buyer ? 'buyer' : 'seller';
  // Step-explainer voicing (Sept 28, 2026): the LATEST FROM card's step
  // name reveals the same one-liner as the checklist row — resolve it with
  // the winning side's voicing, mirroring mostRecentAction's precedence
  // (buyer wins ties). Irrelevant when there is no action (fallback card
  // has no step title), where the default is harmless.
  const tcExplainerRole: 'buyer' | 'seller' =
    view?.seller?.lastAction &&
    (!view?.buyer?.lastAction || view.seller.lastAction.at > view.buyer.lastAction.at)
      ? 'seller'
      : 'buyer';

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
          <MyEscrowsBack />
          <ClientTopCard
            greeting={greeting}
            kicker="Transaction coordinator"
            address={view.address}
            city={view.city}
            daysToClose={view.daysToClose}
            done={done}
            total={total}
            profile={profile}
            status={view.buyer?.status ?? view.seller?.status}
            openDate={view.buyer?.openDate ?? view.seller?.openDate}
            closeDate={view.buyer?.closeDate ?? view.seller?.closeDate}
            // The banner photo opens the IN-APP realtor profile (never the
            // public /realtor/<id> page) — the shared celebration wiring via
            // the escrow id. (Sept 2026: photo taps were misrouted to the
            // public page, which is how the old three-stat white box showed.)
            onProfilePress={() =>
              router.push({ pathname: '/realtor-profile', params: { escrowId: id } })
            }
          />

          {/* TC intake (Sept 29, 2026, mockup 04 device 4): "View listing
              details" — directly below the top card, above the checklist, on
              listing-side escrows only (buyer-only TC views never see it).
              Read-only; opens the details page. */}
          {showTcDetailsForTcView(view.seller !== null) && (
            <TcEntryCard
              title="View listing details"
              caption="Listing information from your realtor"
              icon="eye"
              trailing="chevron"
              onPress={() => router.push(`/tc-listing-details/${id}`)}
              accessibilityLabel="View listing details."
              accessibilityHint="Opens the listing details from your realtor."
              testID="tc-view-listing-details"
            />
          )}

          {/* "LATEST FROM {NAME}" (mockup screen 7): directly below the top
              card, above the checklist, in every state — always visible. */}
          <LatestFromCard
            lastAction={tcLastAction}
            steps={tcSteps}
            realtorName={profile?.name ?? ''}
            openedAt={view.buyer?.openedAt ?? view.seller?.openedAt}
            openDate={view.buyer?.openDate ?? view.seller?.openDate}
            role={tcExplainerRole}
          />

          {/* "KEY DATES" (Sept 28, 2026, FINAL: entry point + sheet, not an
              inline card): escrow-level, directly below LATEST FROM. */}
          <KeyDatesEntryPoint
            onPress={() => setKeyDatesOpen(true)}
            closeDate={(view.buyer ?? view.seller)?.closeDate ?? ''}
            inspectionDeadline={(view.buyer ?? view.seller)?.inspectionDeadline}
            appraisalDeadline={(view.buyer ?? view.seller)?.appraisalDeadline}
            loanApprovalDate={(view.buyer ?? view.seller)?.loanApprovalDate}
            steps={keyDateSide?.steps ?? []}
            role={keyDateRole}
          />
          <KeyDatesSheet
            visible={keyDatesOpen}
            onClose={() => setKeyDatesOpen(false)}
            closeDate={(view.buyer ?? view.seller)?.closeDate ?? ''}
            inspectionDeadline={(view.buyer ?? view.seller)?.inspectionDeadline}
            appraisalDeadline={(view.buyer ?? view.seller)?.appraisalDeadline}
            loanApprovalDate={(view.buyer ?? view.seller)?.loanApprovalDate}
          />

          {view.buyer ? <SideSection title="Buyer checklist" view={view.buyer} /> : null}
          {view.seller ? <SideSection title="Seller checklist" view={view.seller} /> : null}

          <Text style={styles.note}>
            Updated by your realtor.{'\n'}This view is read-only.
          </Text>
          <JoinAnotherEscrow />
        </>
      )}
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
  section: {
    marginTop: 6,
    marginBottom: 10,
  },
  sectionCap: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 4,
    marginBottom: 10,
  },
  note: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 18.75,
    marginTop: 22,
  },
});
