import React, { useCallback, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { auth } from '../src/lib/auth';
import { store } from '../src/lib/store-instance';
import { shouldShowProfileNudge } from '../src/lib/bootRoute';
import type { ClientRole, Escrow, RealtorProfile, StepT } from '../src/lib/types';
import { DealCard } from '../src/components/DealCard';
import { daysToClose } from '../src/lib/dates';
import { formatShortDate } from '../src/components/TimeTrackerCard';
import { Kicker, PrimaryButton } from '../src/components/ui';
import { initialsOf } from '../src/components/ui';
import NewEscrowSheet from '../src/components/NewEscrowSheet';
import { colors } from '../src/theme';

export type Role = ClientRole;

/** "Buyer: Priya Nair" — the client half of the line. DealCard prefixes the city itself. */
export function partyLine(e: Escrow): string {
  const buyer = e.buyerName?.trim() ?? '';
  const seller = e.sellerName?.trim() ?? '';
  if (e.side === 'both') {
    return `Buyer: ${buyer} · Seller: ${seller}`;
  }
  if (e.side === 'sell') {
    return `Seller: ${seller}`;
  }
  return `Buyer: ${buyer}`;
}

function stepsFor(e: Escrow, role: Role): StepT[] {
  return role === 'buyer' ? e.buyerSteps : e.sellerSteps;
}

function countDone(steps: StepT[]): number {
  return steps.reduce((n, s) => n + (s.done ? 1 : 0), 0);
}

interface CardBits {
  done: number;
  total: number;
  fracLabel: string;
  frac: number;
}

function cardBits(e: Escrow): CardBits {
  if (e.side === 'both') {
    const b = stepsFor(e, 'buyer');
    const s = stepsFor(e, 'seller');
    const bDone = countDone(b);
    const sDone = countDone(s);
    const total = b.length + s.length;
    const done = bDone + sDone;
    return {
      done,
      total,
      fracLabel: `${bDone} / ${b.length} · ${sDone} / ${s.length}`,
      frac: total > 0 ? done / total : 0,
    };
  }
  const steps = stepsFor(e, e.side === 'sell' ? 'seller' : 'buyer');
  const done = countDone(steps);
  return {
    done,
    total: steps.length,
    fracLabel: `${done} / ${steps.length} steps`,
    frac: steps.length > 0 ? done / steps.length : 0,
  };
}

function daysUntil(closeDate: string): number {
  // Same convention as every other surface: whole calendar days, DST-safe.
  try {
    return daysToClose(closeDate);
  } catch {
    return 0;
  }
}

interface ChipBits {
  chip: string;
  chipUrgent: boolean;
  chipClosed: boolean;
}

function chipBits(e: Escrow): ChipBits {
  if (e.status === 'closed') {
    return {
      chip: `Closed ${formatShortDate(e.closeDate)}`,
      chipUrgent: false,
      chipClosed: true,
    };
  }
  const left = daysUntil(e.closeDate);
  if (left < 0) {
    return { chip: 'Past target date', chipUrgent: true, chipClosed: false };
  }
  const label = `${left} ${left === 1 ? 'day' : 'days'} to close`;
  return { chip: label, chipUrgent: left <= 10, chipClosed: false };
}

export default function DealList() {
  const router = useRouter();
  const [escrows, setEscrows] = useState<Escrow[]>([]);
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [profileIncomplete, setProfileIncomplete] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);

  const load = useCallback(async () => {
    try {
      setEscrows(await store.listEscrows());
    } catch (err) {
      console.warn('listEscrows failed', err);
    }
    try {
      const [p, skipped] = await Promise.all([
        store.getProfile(),
        auth.getProfileSkipped(),
      ]);
      setProfile(p);
      // "Complete your profile" shows only when profile creation was
      // explicitly skipped during sign-up (approved mockup 24) — never
      // merely because no local profile row exists yet.
      setProfileIncomplete(shouldShowProfileNudge({ skipped }));
    } catch {
      // Profile is decorative here; the list still renders.
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const open = escrows
    .filter((e) => e.status !== 'closed')
    .sort((a, b) => a.closeDate.localeCompare(b.closeDate));
  const closed = escrows
    .filter((e) => e.status === 'closed')
    .sort((a, b) => b.closeDate.localeCompare(a.closeDate));

  const renderDeal = (e: Escrow) => {
    const bits = cardBits(e);
    const chip = chipBits(e);
    return (
      <View key={e.id} style={styles.dealWrap}>
        <DealCard
          address={e.address}
          city={e.city}
          partyLine={partyLine(e)}
          side={e.side}
          chip={chip.chip}
          chipUrgent={chip.chipUrgent}
          chipClosed={chip.chipClosed}
          fracLabel={bits.fracLabel}
          frac={bits.frac}
          onPress={() => router.push(`/escrow/${e.id}`)}
        />
      </View>
    );
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.headRow}>
        <View>
          <Kicker>Realtor</Kicker>
          <Text style={styles.h2}>Escrows</Text>
        </View>
        <Pressable
          onPress={() => router.push('/profile-update')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Your profile"
          style={styles.avatarBtn}
        >
          {profile?.photoUri ? (
            <Image source={{ uri: profile.photoUri }} style={styles.avatar} />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.avatarInitials}>{initialsOf(profile?.name ?? '')}</Text>
            </View>
          )}
        </Pressable>
      </View>
      <Text style={styles.count}>{`${open.length} open · ${closed.length} closed`}</Text>

      {escrows.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyKicker}>Get started</Text>
          <Text style={styles.emptyTitle}>No escrows yet</Text>
          <Text style={styles.emptyText}>
            Open your first escrow to start tracking it — your buyer or seller
            can follow along from their phone.
          </Text>
          <PrimaryButton title="+ New escrow" onPress={() => setSheetVisible(true)} />
          {profileIncomplete ? (
            <Pressable
              onPress={() => router.push('/profile-update')}
              hitSlop={8}
              style={styles.completeProfileWrap}
            >
              <Text style={styles.completeProfile}>Complete your profile →</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <>
          {open.map(renderDeal)}
          <View style={styles.newBtnWrap}>
            <PrimaryButton title="+ New escrow" onPress={() => setSheetVisible(true)} />
          </View>
          {closed.length > 0 && (
            <>
              <Text style={styles.sectionHead}>Closed</Text>
              {closed.map(renderDeal)}
            </>
          )}
        </>
      )}

      <NewEscrowSheet
        visible={sheetVisible}
        onClose={() => setSheetVisible(false)}
        onCreated={(id) => {
          setSheetVisible(false);
          router.push(`/escrow/${id}`);
        }}
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
    padding: 18,
    paddingBottom: 40,
  },
  headRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginTop: 14,
    marginBottom: 4,
  },
  h2: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.ink,
    marginTop: 2,
  },
  avatarBtn: {
    width: 48,
    height: 48,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitials: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
  },
  count: {
    fontSize: 13,
    color: colors.muted,
    marginBottom: 14,
  },
  dealWrap: {
    marginBottom: 14,
  },
  newBtnWrap: {
    marginTop: 6,
  },
  sectionHead: {
    fontSize: 12,
    letterSpacing: 1.4,
    textTransform: 'uppercase',
    color: colors.muted,
    fontWeight: '700',
    marginTop: 22,
    marginBottom: 10,
  },
  empty: {
    marginTop: 56,
    alignItems: 'stretch',
    paddingHorizontal: 8,
  },
  emptyKicker: {
    fontSize: 12,
    letterSpacing: 1.7,
    textTransform: 'uppercase',
    color: colors.accent,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.ink,
    textAlign: 'center',
    marginTop: 6,
  },
  emptyText: {
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.body,
    textAlign: 'center',
    marginTop: 10,
    marginBottom: 20,
  },
  completeProfileWrap: {
    marginTop: 18,
    alignSelf: 'center',
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  completeProfile: {
    fontSize: 15,
    color: colors.accent,
    fontWeight: '700',
  },
});
