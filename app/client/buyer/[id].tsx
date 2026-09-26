// Clear to Close — buyer home view (read-only).
// Faithful to APPROVED mockup 01 · device 4 (+ device 11 live-update details),
// reworked Sept 26: the client top card (see ClientTopCard) leads with a bold
// "Hi {name}" greeting, "Your purchase" kicker + non-bold address, the
// realtor's photo circle top-right at the greeting level (tap -> full
// profile); centered below: "N of N steps" above the bigger progress ring,
// then the days-left line ("days left: N" / "due today" / red "overdue by N
// day(s)"). When every step is checked, the banner slot shows "Congratulations,
// your checklist is complete". The single ordered checklist in the realtor's
// order sits below — checked steps stay in place, UP NEXT on the first
// remaining step, no tap targets, no drag grips, no Custom tag, no JUST NOW
// markers. The standalone realtor card is removed (Sept 25).
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { store } from '../../../src/lib/store-instance';
import { auth } from '../../../src/lib/auth';
import { useClientLinkGate } from '../../../src/hooks/useClientLinkGate';
import type { ClientView, RealtorProfile } from '../../../src/lib/types';
import { SecondaryButton } from '../../../src/components/ui';
import { ClientTopCard } from '../../../src/components/ClientTopCard';
import { ReadOnlyChecklist } from '../../../src/components/Checklist';
import { colors } from '../../../src/theme';

export default function BuyerView() {
  const router = useRouter();
  const raw = useLocalSearchParams().id;
  const id = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  const [view, setView] = useState<ClientView | null>(null);
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [partyName, setPartyName] = useState('');
  // The device link is revalidated on every focus, BEFORE the escrow
  // renders — a revoked/superseded link routes to /link-dead.
  const { gateState, retry } = useClientLinkGate(id, 'buyer');

  useFocusEffect(
    useCallback(() => {
      let active = true;
      if (id) {
        store
          .getBuyerView(id)
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

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {gateState === 'checking' ? (
        <Text style={styles.loading}>Loading…</Text>
      ) : gateState === 'error' ? (
        <View style={styles.gateError}>
          <Text style={styles.gateErrorText}>
            Couldn&apos;t verify your invite link — check your connection and try again.
          </Text>
          <SecondaryButton title="Try again" onPress={retry} />
        </View>
      ) : !view ? (
        <Text style={styles.loading}>Loading…</Text>
      ) : (
        <>
          <ClientTopCard
            greeting={greeting}
            kicker="Your purchase"
            address={view.address}
            city={view.city}
            daysToClose={view.daysToClose}
            done={view.done}
            total={view.total}
            profile={profile}
            onProfilePress={() =>
              router.push({ pathname: '/client/profile', params: { escrowId: id } })
            }
          />

          <ReadOnlyChecklist steps={view.steps} />

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
  note: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 18.75,
    marginTop: 22,
  },
});
