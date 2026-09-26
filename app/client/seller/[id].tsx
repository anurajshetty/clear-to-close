// Clear to Close — seller home view (read-only).
// Faithful to APPROVED mockup 01 · device 14 (+ device 11 live-update details):
// bold "Hi {name}" greeting, "Your purchase" kicker + non-bold address, the
// realtor's photo circle above the progress ring (tap -> full profile), and
// the single ordered checklist in the realtor's order — checked steps stay in
// place, UP NEXT on the first remaining step, no tap targets, no drag grips,
// no Custom tag. The standalone realtor card is removed (Sept 25).
import React, { useCallback, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { store } from '../../../src/lib/store-instance';
import { auth } from '../../../src/lib/auth';
import { useClientLinkGate } from '../../../src/hooks/useClientLinkGate';
import type { ClientView, RealtorProfile } from '../../../src/lib/types';
import { Card, Kicker, SecondaryButton, initialsOf } from '../../../src/components/ui';
import { ProgressRing } from '../../../src/components/ProgressRing';
import { ReadOnlyChecklist, RecentUpdatePill } from '../../../src/components/Checklist';
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
          <Card style={styles.hero}>
            <Text style={styles.greeting}>{greeting}</Text>
            <Kicker>Your sale</Kicker>
            <Text style={styles.byaddr}>
              {view.address} · {view.city}
            </Text>
            <View style={styles.daysRow}>
              {view.daysToClose < 0 ? (
                <Text style={styles.pastTarget}>
                  {Math.abs(view.daysToClose)} days past target
                </Text>
              ) : (
                <View>
                  <Text style={styles.big}>{view.daysToClose}</Text>
                  <Text style={styles.daysLabel}>days to close</Text>
                </View>
              )}
              <View style={styles.ringWrap}>
                <Pressable
                  onPress={() =>
                    router.push({ pathname: '/client/profile', params: { escrowId: id } })
                  }
                  accessibilityRole="button"
                  accessibilityLabel={`View your realtor ${profile?.name ?? ''}'s full profile`}
                  style={styles.rav}
                >
                  <View style={styles.rphotoHalo}>
                    {profile?.photoUri ? (
                      <Image source={{ uri: profile.photoUri }} style={styles.rphoto} />
                    ) : (
                      <View style={styles.rphoto}>
                        <Text style={styles.rphotoInitials}>
                          {initialsOf(profile?.name ?? '')}
                        </Text>
                      </View>
                    )}
                  </View>
                </Pressable>
                <ProgressRing done={view.done} total={view.total} size={72} />
                <Text style={styles.ringCap}>
                  {view.done} of {view.total} steps
                </Text>
              </View>
            </View>
            <RecentUpdatePill steps={view.steps} />
          </Card>

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
  hero: {
    marginTop: 14,
    paddingVertical: 20,
    paddingHorizontal: 16,
  },
  greeting: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.24,
    marginBottom: 6,
  },
  byaddr: {
    fontSize: 14.5,
    fontWeight: '400',
    color: colors.body,
    lineHeight: 21,
    marginBottom: 14,
  },
  daysRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  big: {
    fontSize: 44,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.88,
    lineHeight: 44,
  },
  daysLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.body,
    marginTop: 4,
  },
  pastTarget: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.red,
    flexShrink: 1,
  },
  ringWrap: {
    alignItems: 'center',
  },
  // Realtor photo entry point: circle above the ring (mockup 01 · .rav).
  rav: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  rphotoHalo: {
    // Soft accent halo outside the white ring (mockup 01 · .rav .rphoto).
    backgroundColor: colors.accentSoft,
    borderRadius: 29,
    padding: 2,
  },
  rphoto: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  rphotoInitials: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 17,
  },
  ringCap: {
    fontSize: 11.5,
    fontWeight: '700',
    color: colors.body,
    marginTop: 4,
  },
  note: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 18.75,
    marginTop: 22,
  },
});
