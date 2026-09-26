// Clear to Close — buyer home view (read-only).
// Faithful to APPROVED mockup 01 · device 4.
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { store } from '../../../src/lib/store-instance';
import type { ClientView, RealtorProfile } from '../../../src/lib/types';
import { Card, Kicker } from '../../../src/components/ui';
import { ProgressRing } from '../../../src/components/ProgressRing';
import { RealtorCard } from '../../../src/components/RealtorCard';
import { colors } from '../../../src/theme';

const UP_NEXT_DEFAULT_SUB = 'Your realtor is working on this step of your purchase.';

export default function BuyerView() {
  const router = useRouter();
  const raw = useLocalSearchParams().id;
  const id = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  const [view, setView] = useState<ClientView | null>(null);
  const [profile, setProfile] = useState<RealtorProfile | null>(null);

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
      return () => {
        active = false;
      };
    }, [id]),
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {!view ? (
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
          </Card>

          {profile && (
            <RealtorCard
              name={profile.name}
              photoUri={profile.photoUri}
              onPress={() => router.push('/client/profile')}
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

          <Text style={styles.section}>Completed</Text>
          {view.steps.filter((s) => s.done).length > 0 ? (
            <Card style={styles.list}>
              {view.steps
                .filter((s) => s.done)
                .map((s) => (
                  <View key={s.id} style={styles.row}>
                    <View style={styles.check}>
                      <Text style={styles.checkMark}>✓</Text>
                    </View>
                    <Text style={styles.rowTitle}>{s.title}</Text>
                    {s.custom && (
                      <View style={styles.ctag}>
                        <Text style={styles.ctagText}>Custom</Text>
                      </View>
                    )}
                  </View>
                ))}
            </Card>
          ) : (
            <Text style={styles.empty}>Nothing completed yet.</Text>
          )}

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
  list: {
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 'none' as never,
  },
  checkMark: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.accent,
  },
  rowTitle: {
    flex: 1,
    fontSize: 14.5,
    color: colors.body,
    marginLeft: 10,
  },
  ctag: {
    backgroundColor: '#F3E8D2',
    borderRadius: 5,
    paddingVertical: 2,
    paddingHorizontal: 7,
    marginLeft: 8,
  },
  ctagText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    color: '#7A5A1E',
  },
  empty: {
    fontSize: 14,
    color: colors.muted,
  },
  note: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 18.75,
    marginTop: 22,
  },
});
