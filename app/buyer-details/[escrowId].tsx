// Clear to Close — TC buyer-details page (Oct 1, 2026, Anuraj-approved
// mockup 08, device ③).
//
// New top-level route app/buyer-details/[escrowId].tsx: the realtor's
// saved buyer intake, read-only, on buyer-side TC views only. The same
// link gate as the TC screen guards this page — a revoked/superseded link
// routes to /link-dead. No editing, no share button; unfilled values read
// "Not provided". The TC view already fetched buyer_intake via
// get_client_view (migration 0034); buyer/seller payloads never carry it.
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { store } from '../../src/lib/store-instance';
import { useClientLinkGate } from '../../src/hooks/useClientLinkGate';
import { BackChevron, SecondaryButton } from '../../src/components/ui';
import { BuyerIntakeSections } from '../../src/components/BuyerIntakeEntry';
import type { TcView } from '../../src/lib/types';
import { colors, type } from '../../src/theme';

export default function TcBuyerDetailsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const raw = useLocalSearchParams().escrowId;
  const escrowId = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  const [view, setView] = useState<TcView | null>(null);

  const load = useCallback(() => {
    let active = true;
    if (escrowId) {
      store
        .getTcView(escrowId)
        .then((v) => {
          if (active) setView(v);
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [escrowId]);
  const { gateState, retry } = useClientLinkGate(escrowId, 'tc', {
    onForegroundRefresh: load,
  });
  useFocusEffect(load);

  const address = view?.address?.trim() || 'This escrow';
  const intake = view?.buyerIntake ?? null;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 10 }]}
    >
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
          <BackChevron label="Back" onPress={() => router.back()} />
          <Text style={styles.title}>Buyer details</Text>
          <Text style={styles.sub}>{address} · Buyer side</Text>
          {intake ? (
            <BuyerIntakeSections data={intake} fullAddress={address} />
          ) : (
            <Text style={styles.empty}>
              Your realtor hasn&apos;t added the buyer details yet.
            </Text>
          )}
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
    paddingBottom: 40,
  },
  title: {
    fontSize: type.title,
    fontWeight: '800',
    color: colors.ink,
    marginTop: 8,
  },
  sub: {
    fontSize: type.small,
    color: colors.muted,
    marginTop: 2,
    marginBottom: 8,
  },
  loading: {
    fontSize: type.body,
    color: colors.muted,
    marginTop: 24,
  },
  gateError: {
    marginTop: 24,
    gap: 12,
  },
  gateErrorText: {
    fontSize: type.body,
    color: colors.body,
  },
  empty: {
    fontSize: type.body,
    color: colors.muted,
    marginTop: 24,
  },
});
