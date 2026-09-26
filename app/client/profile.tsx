// Clear to Close — client-facing realtor profile (read-only).
// Faithful to APPROVED mockup 01 · device 15: a prominent "Back to my escrow"
// button at the top (returns to the client's own home view), photo/name,
// the license line ONLY when the realtor entered one (empty = no line at
// all), about, stats, areas. No Call / Message actions (removed per Anuraj,
// Sept 25). One profile per realtor, shown across all their escrows.
import React, { useCallback, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { store } from '../../src/lib/store-instance';
import { auth } from '../../src/lib/auth';
import type { ClientRole, RealtorProfile } from '../../src/lib/types';
import { Kicker, initialsOf } from '../../src/components/ui';
import { colors } from '../../src/theme';

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value || '—'}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export default function ClientRealtorProfile() {
  const router = useRouter();
  // The escrow this profile was opened from (buyer/seller home passes it).
  // A client device has no local realtor profile of its own — the linked
  // profile from the invite is the source of truth there.
  const params = useLocalSearchParams<{ escrowId?: string }>();
  const rawEscrowId = params.escrowId;
  const escrowId =
    typeof rawEscrowId === 'string' ? rawEscrowId : Array.isArray(rawEscrowId) ? rawEscrowId[0] : null;
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [homeRoute, setHomeRoute] = useState<{ role: ClientRole; escrowId: string } | null>(
    null,
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      setFailed(false);
      store
        .getClientProfile(escrowId)
        .then((p) => {
          if (active) {
            setProfile(p);
            setFailed(!p);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });
      // "Back to my escrow" returns to THIS client's own home view.
      auth
        .getClientLink()
        .then((link) => {
          if (active && link && (!escrowId || link.escrowId === escrowId)) {
            setHomeRoute({ role: link.role, escrowId: link.escrowId });
          }
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, [escrowId]),
  );

  const goHome = useCallback(() => {
    if (homeRoute) {
      router.replace(`/client/${homeRoute.role}/${homeRoute.escrowId}` as never);
    } else {
      router.back();
    }
  }, [homeRoute, router]);

  const firstName = (profile?.name ?? '').trim().split(/\s+/)[0] ?? '';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to your escrow home screen"
        onPress={goHome}
        style={({ pressed }) => [styles.backHome, pressed && { opacity: 0.85 }]}
      >
        <Text style={styles.backHomeChev}>‹</Text>
        <Text style={styles.backHomeText}>Back to my escrow</Text>
      </Pressable>

      {!profile ? (
        failed ? (
          <Text style={styles.loading}>
            Couldn&apos;t load your realtor&apos;s profile — check your connection and try again.
          </Text>
        ) : (
          <Text style={styles.loading}>Loading…</Text>
        )
      ) : (
        <>
          <View style={styles.hero}>
            {profile.photoUri ? (
              <Image source={{ uri: profile.photoUri }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, styles.photoFallback]}>
                <Text style={styles.initials}>{initialsOf(profile.name)}</Text>
              </View>
            )}
            <Text style={styles.name}>{profile.name}</Text>
            {profile.dreLicense.trim().length > 0 && (
              <Text style={styles.dre}>DRE / license number: {profile.dreLicense.trim()}</Text>
            )}
          </View>

          {profile.about.trim().length > 0 && (
            <View style={styles.block}>
              <Kicker>About</Kicker>
              <Text style={styles.body}>{profile.about}</Text>
            </View>
          )}

          <View style={styles.stats}>
            <Stat value={profile.yearsExperience} label="Years experience" />
            <Stat value={profile.dealsClosed} label="Deals closed" />
          </View>

          {profile.areasServed.trim().length > 0 && (
            <View style={styles.block}>
              <Kicker>Areas served</Kicker>
              <Text style={styles.body}>{profile.areasServed}</Text>
            </View>
          )}

          <Text style={styles.note}>
            {firstName
              ? `One profile — shown across all of ${firstName}'s escrows.\nRead-only for clients.`
              : `One profile — shown across every escrow.\nRead-only for clients.`}
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
    paddingTop: 12,
    paddingBottom: 40,
  },
  // Prominent return to the client's home screen (mockup 01 · .backhome).
  backHome: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginTop: 10,
    backgroundColor: colors.accentSoft,
    borderRadius: 14,
  },
  backHomeChev: {
    fontSize: 26,
    lineHeight: 26,
    fontWeight: '400',
    color: colors.accent,
  },
  backHomeText: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.accent,
  },
  loading: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 40,
  },
  hero: {
    alignItems: 'center',
    marginTop: 26,
  },
  photo: {
    width: 96,
    height: 96,
    borderRadius: 48,
  },
  photoFallback: {
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 34,
  },
  name: {
    fontSize: 24,
    fontWeight: '800',
    color: colors.ink,
    textAlign: 'center',
    marginTop: 14,
  },
  dre: {
    fontSize: 13.5,
    color: colors.muted,
    textAlign: 'center',
    marginTop: 4,
  },
  block: {
    marginTop: 24,
  },
  body: {
    fontSize: 14.5,
    color: colors.body,
    lineHeight: 21.75,
    marginTop: 8,
  },
  stats: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 40,
    marginTop: 24,
  },
  stat: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.ink,
  },
  statLabel: {
    fontSize: 13,
    color: colors.muted,
    marginTop: 2,
  },
  note: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 18.75,
    marginTop: 24,
  },
});
