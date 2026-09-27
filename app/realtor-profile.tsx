// Clear to Close — IN-APP realtor profile (celebration redesign, APPROVED
// v3 by Anuraj, Sept 2026).
//
// Route: /realtor-profile?escrowId=<id>. Opened from the redeem
// celebration's realtor photo and from the client-home banner photo as an
// IN-APP navigation push (never the public /realtor/<id> page); the back
// chevron overlaid on the banner returns to the previous screen, and when
// there is no in-app history (web deep link) it falls back to an explicit
// replace to this device's client home screen.
//
// Layout (approved v3): a 150px banner strip on top (the realtor's synced
// banner, cover-cropped; teal-gradient fallback only when no banner is
// uploaded) with the back chevron overlaid — no title text — and the big
// profile photo overlapping below the banner. The profile body is the shared
// RealtorProfileView in its inApp variant: stats pared to Years in only,
// the "What clients say" reviews section removed; name, subline, about,
// and areas unchanged. Call / Text buttons sit below.
//
// Data comes from the resolved invite realtor via store.getClientProfile
// (linked-first, local fallback) — the same wiring as the celebration, so
// the photo shown here is the synced photo with the device-local fallback.
// Copy: realtor by name only, no gendered pronouns, no em dashes.
import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { auth } from '../src/lib/auth';
import { store } from '../src/lib/store-instance';
import { displayBannerUri } from '../src/lib/profile';
import type { RealtorProfile } from '../src/lib/types';
import { RealtorProfileView } from '../src/components/RealtorProfileView';
import { PrimaryButton, SecondaryButton } from '../src/components/ui';
import { colors } from '../src/theme';

// Banner strip: the realtor's synced banner (same Storage banner.jpg source
// the client home top card uses, device-local fallback offline), cover-
// cropped; the teal gradient is the fallback only when no banner exists
// (Sept 2026 fix — the strip rendered a plain gradient even when a banner
// was uploaded).
function ProfileBanner({
  onBack,
  bannerUri,
}: {
  onBack: () => void;
  bannerUri?: string | null;
}) {
  return (
    <View style={styles.banner} testID="profile-banner-strip">
      {bannerUri ? (
        <Image
          source={{ uri: bannerUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
          testID="profile-banner"
        />
      ) : (
        <Svg
          style={StyleSheet.absoluteFill}
          width="100%"
          height="100%"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          testID="profile-banner-gradient"
        >
          <Defs>
            <LinearGradient id="profileBanner" x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor="#0E3B36" />
              <Stop offset="0.55" stopColor="#175E54" />
              <Stop offset="1" stopColor="#2A7A6C" />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width="100" height="100" fill="url(#profileBanner)" />
        </Svg>
      )}
      <Pressable
        onPress={onBack}
        accessibilityRole="button"
        accessibilityLabel="Back to celebration"
        style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }]}
        testID="profile-back"
      >
        <Text style={styles.backGlyph}>‹</Text>
      </Pressable>
    </View>
  );
}

export default function InAppRealtorProfile() {
  const router = useRouter();
  const params = useLocalSearchParams<{ escrowId?: string }>();
  const raw = params.escrowId;
  const escrowId = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';

  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setProfile(null);
    (async () => {
      try {
        // Converge-on-mount (Sept 2026 stale-profile fix): the old
        // cache-only read stayed stale — refresh the linked view from the
        // server first (fails open offline), then read the snapshot.
        if (escrowId) await store.refreshClientView(escrowId);
        const p = escrowId ? await store.getClientProfile(escrowId) : null;
        if (!active) return;
        if (p) setProfile(p);
        else setFailed(true);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [escrowId]);

  // The back chevron must ALWAYS land the client on their home screen.
  // router.back() alone is not enough: on web the profile can be opened
  // with no in-app history (deep link, public-page entry), where back()
  // goes nowhere. When there is nothing to go back to, fall back to an
  // explicit replace to this device's client home screen (role + escrow
  // from the device link, exactly like the celebration's "View escrow").
  // (Sept 2026 — Anuraj.)
  const goBack = async () => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    try {
      const link = await auth.getClientLink();
      const homeId = escrowId || link?.escrowId;
      if (homeId) {
        router.replace(`/client/${link?.role ?? 'buyer'}/${homeId}`);
        return;
      }
    } catch {
      // Fall through to the last-resort back().
    }
    router.back();
  };
  const phone = (profile?.phone ?? '').trim();
  // Same banner contract as the client home top card: synced Storage URL
  // first, device-local file offline, teal gradient only when no banner.
  const bannerUri = profile ? displayBannerUri(profile) : null;

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView>
        <ProfileBanner onBack={goBack} bannerUri={bannerUri} />
        <View style={styles.content}>
          {!profile ? (
            failed ? (
              <View style={styles.center}>
                <Text style={styles.failTitle}>Profile not available</Text>
                <Text style={styles.failBody}>
                  We could not load your realtor&apos;s profile. Check your connection and try again.
                </Text>
              </View>
            ) : (
              <View style={styles.center}>
                <ActivityIndicator size="large" color={colors.accent} />
              </View>
            )
          ) : (
            <RealtorProfileView
              profile={profile}
              variant="inApp"
              testID="inapp-realtor-profile"
              footer={
                phone ? (
                  <View style={styles.btnRow} testID="realtor-profile-actions">
                    <View style={styles.btnFlex}>
                      <PrimaryButton
                        title="Call"
                        onPress={() => Linking.openURL(`tel:${phone}`)}
                      />
                    </View>
                    <View style={styles.btnFlex}>
                      <SecondaryButton
                        title="Text"
                        onPress={() => Linking.openURL(`sms:${phone}`)}
                      />
                    </View>
                  </View>
                ) : null
              }
            />
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  // Banner strip: full-bleed 150px banner (or teal gradient fallback when
  // no banner is uploaded) with the back chevron overlaid (approved v3 —
  // no title text).
  banner: { height: 150, position: 'relative' },
  backBtn: {
    position: 'absolute',
    top: 14,
    left: 14,
    zIndex: 2,
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backGlyph: { fontSize: 22, fontWeight: '700', color: colors.ink, marginTop: -2 },
  content: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 40 },
  center: { alignItems: 'center', paddingTop: 60 },
  failTitle: { fontSize: 18, fontWeight: '800', color: colors.ink, textAlign: 'center' },
  failBody: {
    fontSize: 14,
    color: colors.body,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 21,
  },
  btnRow: { flexDirection: 'row', gap: 10, marginTop: 22 },
  btnFlex: { flex: 1 },
});
