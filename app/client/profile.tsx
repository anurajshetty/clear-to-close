// Clear to Close — client-facing realtor profile (read-only).
// Faithful to APPROVED mockup 01 · device 15. License line intentionally omitted (HELD).
import React, { useCallback, useState } from 'react';
import {
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { store } from '../../src/lib/store-instance';
import type { RealtorProfile } from '../../src/lib/types';
import { Kicker, PrimaryButton } from '../../src/components/ui';
import { initialsOf } from '../../src/components/RealtorCard';
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
  const [profile, setProfile] = useState<RealtorProfile | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      store
        .getProfile()
        .then((p) => {
          if (active) setProfile(p);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

  const hasPhone = !!profile && profile.phone.trim().length > 0;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={() => router.back()}
        style={styles.back}
      >
        <Text style={styles.backText}>‹ Back</Text>
      </Pressable>

      {!profile ? (
        <Text style={styles.loading}>Loading…</Text>
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

          {hasPhone && (
            <View style={styles.actions}>
              <View style={styles.actionBtn}>
                <PrimaryButton
                  title="Call"
                  onPress={() => Linking.openURL(`tel:${profile.phone.trim()}`)}
                />
              </View>
              <View style={styles.actionBtn}>
                <PrimaryButton
                  title="Message"
                  onPress={() => Linking.openURL(`sms:${profile.phone.trim()}`)}
                />
              </View>
            </View>
          )}

          <Text style={styles.note}>
            One profile — shown across every escrow.{'\n'}Read-only for clients.
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
  back: {
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingRight: 12,
  },
  backText: {
    fontSize: 15,
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
    marginTop: 12,
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
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 24,
  },
  actionBtn: {
    flex: 1,
  },
  note: {
    fontSize: 12.5,
    color: colors.muted,
    textAlign: 'center',
    lineHeight: 18.75,
    marginTop: 24,
  },
});
