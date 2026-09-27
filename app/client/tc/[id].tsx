// Clear to Close — transaction coordinator home view (read-only).
// Sept 2026 (Anuraj's decision): on a "both" escrow the TC sees BOTH
// checklists; on a single-side escrow the active side's. Reuses the same
// ClientTopCard + ReadOnlyChecklist as the buyer/seller views — no
// divergent copies. Same read-only rules: no tap targets, no drag grips,
// no Custom tag, no JUST NOW markers.
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { store } from '../../../src/lib/store-instance';
import { auth } from '../../../src/lib/auth';
import { useClientLinkGate } from '../../../src/hooks/useClientLinkGate';
import type { ClientView, RealtorProfile, TcView } from '../../../src/lib/types';
import { Kicker, SecondaryButton } from '../../../src/components/ui';
import { ClientTopCard } from '../../../src/components/ClientTopCard';
import { ReadOnlyChecklist } from '../../../src/components/Checklist';
import { colors } from '../../../src/theme';

function SideSection({ title, view }: { title: string; view: ClientView }) {
  return (
    <View style={styles.section}>
      <Kicker>{title}</Kicker>
      <Text style={styles.sectionCap} testID={`tc-${view.role}-caption`}>
        {`${view.done} of ${view.total} steps`}
      </Text>
      <ReadOnlyChecklist steps={view.steps} />
    </View>
  );
}

export default function TcView() {
  const router = useRouter();
  const raw = useLocalSearchParams().id;
  const id = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  const [view, setView] = useState<TcView | null>(null);
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [partyName, setPartyName] = useState('');
  // The device link is revalidated on every focus, BEFORE the escrow
  // renders — a revoked/superseded link routes to /link-dead.
  const { gateState, retry } = useClientLinkGate(id, 'tc');

  useFocusEffect(
    useCallback(() => {
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
  const done = (view?.buyer?.done ?? 0) + (view?.seller?.done ?? 0);
  const total = (view?.buyer?.total ?? 0) + (view?.seller?.total ?? 0);

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

          {view.buyer ? <SideSection title="Buyer checklist" view={view.buyer} /> : null}
          {view.seller ? <SideSection title="Seller checklist" view={view.seller} /> : null}

          <Text style={styles.note}>
            Updated by your realtor.{'\n'}This view is read-only.
          </Text>
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
