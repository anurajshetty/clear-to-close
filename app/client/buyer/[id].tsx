// Clear to Close — buyer home view (read-only).
// Faithful to APPROVED mockup 01 · device 4 (+ device 11 live-update details).
// The checklist mirrors the realtor stepper via the shared ClientStepList.
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { store } from '../../../src/lib/store-instance';
import { useClientLinkGate } from '../../../src/hooks/useClientLinkGate';
import type { ClientView, RealtorProfile } from '../../../src/lib/types';
import { Card, Kicker, SecondaryButton } from '../../../src/components/ui';
import { ProgressRing } from '../../../src/components/ProgressRing';
import { RealtorCard } from '../../../src/components/RealtorCard';
import {
  ClientStepList,
  RecentUpdatePill,
} from '../../../src/components/ClientStepList';
import { colors } from '../../../src/theme';

const UP_NEXT_DEFAULT_SUB = 'Your realtor is working on this step of your purchase.';

export default function BuyerView() {
  const router = useRouter();
  const raw = useLocalSearchParams().id;
  const id = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  const [view, setView] = useState<ClientView | null>(null);
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
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
      return () => {
        active = false;
      };
    }, [id]),
  );

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
            <Kicker>Your purchase</Kicker>
            <Text style={styles.address}>{view.address}</Text>
            <Text style={styles.city}>{view.city}</Text>
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
              <View style={styles.ring}>
                <ProgressRing done={view.done} total={view.total} size={72} />
                <Text style={styles.ringCap}>
                  {view.done} of {view.total} steps
                </Text>
              </View>
            </View>
            <RecentUpdatePill steps={view.steps} />
          </Card>

          {profile && (
            <RealtorCard
              name={profile.name}
              photoUri={profile.photoUri}
              onPress={() => router.push({ pathname: '/client/profile', params: { escrowId: id } })}
            />
          )}

          <Text style={styles.section}>Up next</Text>
          <Card style={styles.upNext}>
            {view.upNext ? (
              <>
                <Kicker>Your realtor is on it</Kicker>
                <Text style={styles.upNextTitle}>{view.upNext.title}</Text>
                <Text style={styles.upNextSub}>
                  {view.upNext.subtitle || UP_NEXT_DEFAULT_SUB}
                </Text>
              </>
            ) : (
              <Text style={styles.allDone}>All steps complete — ready to close!</Text>
            )}
          </Card>

          <ClientStepList steps={view.steps} />

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
    paddingHorizontal: 20,
    paddingTop: 20,
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
  address: {
    fontSize: 21,
    fontWeight: '800',
    color: colors.ink,
    marginTop: 8,
  },
  city: {
    fontSize: 14,
    color: colors.muted,
    marginTop: 4,
  },
  daysRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: 16,
  },
  big: {
    fontSize: 44,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.88,
    lineHeight: 44,
  },
  daysLabel: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 2,
  },
  pastTarget: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.red,
    flexShrink: 1,
  },
  ring: {
    alignItems: 'center',
  },
  ringCap: {
    fontSize: 11.5,
    fontWeight: '700',
    color: colors.body,
    marginTop: 4,
  },
  section: {
    fontSize: 12,
    letterSpacing: 1.44,
    textTransform: 'uppercase',
    color: colors.muted,
    fontWeight: '700',
    marginTop: 20,
    marginBottom: 10,
  },
  upNext: {
    borderTopWidth: 4,
    borderTopColor: colors.accent,
    paddingTop: 14,
  },
  upNextTitle: {
    fontSize: 17,
    fontWeight: '800',
    color: colors.ink,
    marginTop: 6,
  },
  upNextSub: {
    fontSize: 14.5,
    color: colors.body,
    lineHeight: 21.75,
    marginTop: 6,
  },
  allDone: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
  },
  note: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 18.75,
    marginTop: 22,
  },
});
