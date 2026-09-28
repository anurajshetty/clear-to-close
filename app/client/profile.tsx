// Clear to Close — client-facing realtor profile (read-only).
// Faithful to APPROVED mockup 01 · device 15: a prominent "Back to my escrow"
// button at the top (returns to the client's own home view), photo/name,
// the license line ONLY when the realtor entered one (empty = no line at
// all), about, stats, areas. No Call / Message actions (removed per Anuraj,
// Sept 25). One profile per realtor, shown across all their escrows.
import React, { createElement, useCallback, useEffect, useState } from 'react';
import { AppState, Image, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { store } from '../../src/lib/store-instance';
import { auth } from '../../src/lib/auth';
import { getPushPermission } from '../../src/lib/push';
import type { ClientRole, RealtorProfile } from '../../src/lib/types';
import { realtorSubline } from '../../src/lib/profile';
import { Card, Kicker, initialsOf } from '../../src/components/ui';
import { colors } from '../../src/theme';

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value || '·'}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export default function ClientRealtorProfile() {
  const router = useRouter();
  // iOS (Sept 2026): the "Back to my escrow" button crowded the status
  // bar — clear the safe-area inset plus the existing gap (12).
  const insets = useSafeAreaInsets();
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
  // Quiet push hint: shown only when this device denied notification
  // permission (never nags; the ask-once pre-prompt lives in PushGate).
  const [pushOff, setPushOff] = useState(false);

  // Data load, shared by focus and foreground (Sept 2026
  // foreground-refresh fix): the linked profile is refetched from the cloud
  // view first — the old cache-only read never fetched, so the realtor's
  // name/photo stayed stale across refresh and foreground return.
  const load = useCallback(() => {
    let active = true;
    setFailed(false);
    const profileP = escrowId
      ? store.refreshClientView(escrowId).then(() => store.getClientProfile(escrowId))
      : store.getClientProfile(null);
    profileP
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
    // Quiet push hint state (native only; web is out of push scope).
    if (Platform.OS !== 'web') {
      getPushPermission()
        .then((p) => {
          if (active) setPushOff(p === 'denied');
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [escrowId]);

  useFocusEffect(load);

  // Foreground return does not refocus the screen: reload the same way.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') load();
    });
    return () => sub.remove();
  }, [load]);

  const goHome = useCallback(() => {
    if (homeRoute) {
      router.replace(`/client/${homeRoute.role}/${homeRoute.escrowId}` as never);
    } else {
      router.back();
    }
  }, [homeRoute, router]);

  const firstName = (profile?.name ?? '').trim().split(/\s+/)[0] ?? '';

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, { paddingTop: insets.top + 12 }]}>
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
            Couldn&apos;t load your realtor&apos;s profile. Check your connection and try again.
          </Text>
        ) : (
          <Text style={styles.loading}>Loading…</Text>
        )
      ) : (
        <>
          {/* Hero card: photo 96px → name → license (only when entered) →
              tap-to-call phone row (mockup 01 · ⑮). */}
          <Card style={styles.heroCard}>
            {profile.photoUri ? (
              <Image source={{ uri: profile.photoUri }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, styles.photoFallback]}>
                <Text style={styles.initials}>{initialsOf(profile.name)}</Text>
              </View>
            )}
            <Text style={styles.name}>{profile.name}</Text>
            {realtorSubline(profile) && (
              <Text style={styles.dre}>{realtorSubline(profile)}</Text>
            )}
            {profile.phone.trim().length > 0 && (
              Platform.OS === 'web' ? (
                // The approved mockup renders a real tap-to-call anchor.
                createElement(
                  'a',
                  {
                    href: `tel:${profile.phone.trim()}`,
                    'aria-label': `Call ${profile.name} at ${profile.phone.trim()}`,
                    style: {
                      ...StyleSheet.flatten(styles.phoneRow),
                      textDecorationLine: 'none',
                      cursor: 'pointer',
                    },
                  },
                  <Text style={styles.phoneLabel}>Phone</Text>,
                  <Text style={styles.phoneNum}>{profile.phone.trim()}</Text>,
                )
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Call ${profile.name} at ${profile.phone.trim()}`}
                  onPress={() => Linking.openURL(`tel:${profile.phone.trim()}`)}
                  style={({ pressed }) => [styles.phoneRow, pressed && { opacity: 0.55 }]}
                >
                  <Text style={styles.phoneLabel}>Phone</Text>
                  <Text style={styles.phoneNum}>{profile.phone.trim()}</Text>
                </Pressable>
              )
            )}
          </Card>

          {profile.about.trim().length > 0 && (
            <Card style={styles.blockCard}>
              <Kicker>About</Kicker>
              <Text style={styles.body}>{profile.about}</Text>
            </Card>
          )}

          <Card style={styles.blockCard}>
            <View style={styles.stats}>
              <Stat value={profile.yearsExperience} label="Years experience" />
            </View>
          </Card>

          {profile.areasServed.trim().length > 0 && (
            <Card style={styles.blockCard}>
              <Kicker>Areas served</Kicker>
              <Text style={styles.body}>{profile.areasServed}</Text>
            </Card>
          )}

          <Text style={styles.note}>
            {firstName
              ? `One profile, shown across all of ${firstName}'s escrows.\nRead-only for clients.`
              : `One profile, shown across every escrow.\nRead-only for clients.`}
          </Text>
          {pushOff && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Settings to turn notifications on"
              onPress={() => {
                if (Platform.OS !== 'web') Linking.openSettings().catch(() => {});
              }}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.note}>
                Notifications are off. Turn them on in Settings to get step updates.
              </Text>
            </Pressable>
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
  heroCard: {
    alignItems: 'center',
    marginTop: 26,
    paddingVertical: 24,
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
  // Tap-to-call phone row (mockup 01 · .pfphone): PHONE label left, number
  // right, hairline top border, 52px min-height.
  phoneRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    alignSelf: 'stretch',
    minHeight: 52,
    marginTop: 16,
    marginHorizontal: 4,
    paddingTop: 14,
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: 'rgba(231,224,211,.8)',
  },
  phoneLabel: {
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.muted,
  },
  phoneNum: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.accent,
  },
  blockCard: {
    marginTop: 14,
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
    paddingVertical: 6,
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
