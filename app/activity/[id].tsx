// Clear to Close — per-escrow activity timeline (Team Access, frame 5).
// Faithful to APPROVED team-access mockup frame 5 (Oct 20, 2026): every
// change on the escrow lands here with the person's name and a FIXED
// timestamp — entries never tick or change after the fact. Day-grouped
// cards ("Today" / "Yesterday" / "Oct 12"), actor avatar initials, name
// bold ahead of the action, time right-aligned (time alone today,
// "Oct 19 · 4:26 PM" on older days). Server-written rows only
// (escrow_activity, migration 0044) — the screen is a pure reader.
import React, { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { store } from '../../src/lib/store-instance';
import type { Escrow } from '../../src/lib/types';
import type { TeamActivityEntry } from '../../src/lib/teamModel';
import {
  activityLineParts,
  activityTimeLabel,
  groupActivityByDay,
} from '../../src/lib/teamActivityText';
import { BackChevron, Card, SecondaryButton, initialsOf } from '../../src/components/ui';
import { colors } from '../../src/theme';


export default function EscrowActivity() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const rawId = params.id;
  const escrowId = Array.isArray(rawId) ? rawId[0] : rawId;

  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [entries, setEntries] = useState<TeamActivityEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!escrowId) return;
    try {
      setEscrow(await store.getEscrow(escrowId));
    } catch (err) {
      console.warn('activity getEscrow failed', err);
    }
    try {
      const rows = await store.listEscrowActivity(escrowId);
      setEntries(rows);
    } catch (err) {
      console.warn('listEscrowActivity failed', err);
    } finally {
      setLoaded(true);
    }
  }, [escrowId]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  if (!loaded) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>Loading…</Text>
      </View>
    );
  }

  if (!escrow) {
    return (
      <View style={styles.center}>
        <Text style={styles.centerText}>Escrow not found</Text>
        <View style={styles.centerBtn}>
          <SecondaryButton title="Back to escrows" onPress={() => router.back()} />
        </View>
      </View>
    );
  }

  const groups = groupActivityByDay(entries);
  const nowMs = Date.now();

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + 14 }]}>
        <View style={styles.backBtn}>
          <BackChevron label="Details" onPress={() => router.back()} />
        </View>
        <Text style={styles.title}>Activity</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {escrow.address}
        </Text>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {entries.length === 0 ? (
          <Text style={styles.empty}>
            No activity yet. Check-offs, intake saves, and team changes will
            show up here.
          </Text>
        ) : (
          groups.map((g) => (
            <View key={g.label}>
              <Text style={styles.dayLabel}>{g.label}</Text>
              <Card style={styles.dayCard}>
                {g.entries.map((entry, idx) => {
                  const parts = activityLineParts(entry);
                  const actorName = (
                    entry.actorName ??
                    entry.actorLabel ??
                    ''
                  ).trim();
                  // Client actors (snapshot label, no account) render
                  // grey; everyone else the teal initial disc.
                  const isClient = entry.actorId == null && entry.actorLabel != null;
                  return (
                    <View
                      key={entry.id}
                      style={[styles.row, idx === g.entries.length - 1 && styles.rowLast]}
                      testID={`activity-row-${entry.id}`}
                    >
                      <View style={[styles.dot, isClient && styles.dotClient]}>
                        <Text
                          style={[
                            styles.dotText,
                            isClient && styles.dotTextClient,
                          ]}
                        >
                          {initialsOf(actorName || '?')}
                        </Text>
                      </View>
                      <Text style={styles.rowText}>
                        {parts.map((p, i) => (
                          <Text key={i} style={p.bold ? styles.rowTextBold : undefined}>
                            {p.text}
                          </Text>
                        ))}
                      </Text>
                      <Text style={styles.rowTime}>
                        {activityTimeLabel(entry.createdAt, nowMs)}
                      </Text>
                    </View>
                  );
                })}
              </Card>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.paper,
    padding: 24,
  },
  centerText: {
    fontSize: 15,
    color: colors.body,
  },
  centerBtn: {
    marginTop: 16,
    minWidth: 200,
  },
  header: {
    paddingHorizontal: 18,
    paddingBottom: 12,
    backgroundColor: colors.paper,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  backBtn: {
    alignSelf: 'flex-start',
    minHeight: 44,
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.2,
    marginTop: 2,
  },
  subtitle: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 4,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: 18,
    paddingTop: 6,
    paddingBottom: 36,
  },
  empty: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.muted,
    marginTop: 18,
    marginHorizontal: 2,
  },
  // Frame 5 day label: small caps muted above each day's card.
  dayLabel: {
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.muted,
    fontWeight: '800',
    marginTop: 16,
    marginBottom: 6,
    marginHorizontal: 2,
  },
  dayCard: {
    paddingVertical: 4,
    paddingHorizontal: 14,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 11,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  dot: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  dotClient: {
    backgroundColor: colors.line,
  },
  dotText: {
    fontSize: 12,
    fontWeight: '800',
    color: colors.accent,
  },
  dotTextClient: {
    color: colors.body,
  },
  rowText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.ink,
  },
  rowTextBold: {
    fontWeight: '700',
    color: colors.ink,
  },
  rowTime: {
    fontSize: 12,
    color: colors.muted,
    marginTop: 2,
    flexShrink: 0,
  },
});
