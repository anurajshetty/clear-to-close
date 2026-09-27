// Clear to Close — client redeem celebration (celebration redesign,
// APPROVED by Anuraj, Sept 2026).
//
// A light celebration card shown right after a client redeems their invite
// code: white card (24pt radius, 1px #E7E0D3 border) with the realtor's
// banner image as a 132px header strip (brand-teal gradient fallback when no
// banner is uploaded — never a profile photo on the banner), then the amber
// "Congratulations, {client name}" kicker, the ink "Your escrow is open!"
// headline, "<realtor name> has your checklist ready." and "Follow your
// progress right here."
//
// Below the card: "View my escrow" (pulled close to the card), "Not your
// escrow? Start over", then the "YOUR REALTOR" label with the centered
// realtor photo (~124px) — tapping the photo opens the realtor profile
// IN-APP (an in-app navigation push, never a browser tab). The realtor data
// comes from the resolved invite realtor (name + synced photo).
//
// The unified confetti BURST (the shared ConfettiBurst from
// src/components/Confetti.tsx — one implementation reused everywhere, no
// local copies) pops up from below the card when the celebration appears;
// skipped when the OS reduced-motion setting is on. Pure React Native +
// react-native-svg (already linked everywhere) — identical on iOS and web,
// no new native modules.
//
// Copy rules: the realtor is referred to by name only (no gendered
// pronouns); no em dashes in user-facing copy.
import React, { useEffect, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { store } from '../lib/store-instance';
import type { ClientRole, RealtorProfile } from '../lib/types';
import { displayBannerUri, displayPhotoUri } from '../lib/profile';
import { CELEBRATION_BANNER } from '../lib/bannerSize';
import {
  celebrationChecklistReady,
  celebrationFollowProgress,
  celebrationHeadline,
  celebrationKicker,
  celebrationRealtorLabel,
} from '../lib/shareCopy';
import { ConfettiBurst } from './Confetti';
import { PrimaryButton, TextLink, initialsOf } from './ui';

const AMBER = '#A86A12';
const INK = '#211D17';
const BODY = '#5F574C';
const MUTED = '#8A8175';
const LINE = '#E7E0D3';
const PHOTO_BORDER = '#CFC6B4';

/** Brand-teal gradient fallback for the banner strip when no banner is set. */
function TealGradientFallback({ testID }: { testID?: string }) {
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      testID={testID}
    >
      <Defs>
        <LinearGradient id="celebrateBanner" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#0E3B36" />
          <Stop offset="55%" stopColor="#175E54" />
          <Stop offset="100%" stopColor="#2A7A6C" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill="url(#celebrateBanner)" />
    </Svg>
  );
}

function CelebrationCard({
  clientName,
  name,
  bannerUri,
}: {
  clientName: string;
  name: string;
  bannerUri: string | null;
}) {
  const [cardW, setCardW] = useState(0);
  const [cardH, setCardH] = useState(0);
  return (
    <View
      style={styles.card}
      testID="redeem-celebration-card"
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout;
        setCardW(width);
        setCardH(height);
      }}
    >
      {/* Banner header strip at the top of the card (Anuraj, Sept 2026):
          the realtor's synced banner image, cover-cropped; the brand-teal
          gradient strip is the fallback when no banner is uploaded. No
          profile photo on the banner. */}
      <View style={styles.bannerStrip} testID="celebration-banner-strip">
        {bannerUri ? (
          <Image
            source={{ uri: bannerUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            testID="celebration-banner"
          />
        ) : (
          <TealGradientFallback testID="celebration-gradient" />
        )}
      </View>
      {/* The unified confetti BURST pops up from below the card (the shared
          ConfettiBurst — one confetti implementation, same look and motion
          everywhere; reduced-motion aware). */}
      <ConfettiBurst cardWidth={cardW} cardHeight={cardH} testID="redeem-confetti-burst" />
      <View style={styles.cardBody}>
        <Text style={styles.kicker} testID="celebration-kicker">
          {celebrationKicker(clientName)}
        </Text>
        <Text style={styles.headline} testID="celebration-headline">
          {celebrationHeadline()}
        </Text>
        <Text style={styles.sub} testID="celebration-checklist-ready">
          {celebrationChecklistReady(name)}
        </Text>
        <Text style={styles.sub2}>{celebrationFollowProgress()}</Text>
      </View>
    </View>
  );
}

/**
 * The redeem-success screen: celebration card, then "View my escrow",
 * then "Not your escrow? Start over", then the YOUR REALTOR label with the
 * tappable realtor photo (in-app profile). The realtor's profile is the one
 * attached to the escrow being redeemed (linked-first, local fallback).
 */
export function RedeemCelebration({
  escrowId,
  role,
  clientName,
  onViewEscrow,
  onStartOver,
  onProfilePress,
}: {
  escrowId: string;
  role: ClientRole;
  /** The redeemed invite's party name (server-validated at redeem time). */
  clientName: string;
  onViewEscrow: () => void;
  onStartOver: () => void;
  /**
   * Tapping the realtor photo opens the realtor profile IN-APP (an in-app
   * navigation push, never a browser tab).
   */
  onProfilePress: () => void;
}) {
  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      let p: RealtorProfile | null = null;
      try {
        p = await store.getClientProfile(escrowId);
        if (!p) {
          // Warm the linked-profile cache from the cloud client view, then
          // retry once — the realtor's profile travels with the view.
          try {
            if (role === 'buyer') await store.getBuyerView(escrowId);
            else if (role === 'seller') await store.getSellerView(escrowId);
            else await store.getTcView(escrowId);
          } catch {
            // Offline or cloud unreachable: fall through to the fallback.
          }
          p = await store.getClientProfile(escrowId);
        }
      } catch {
        p = null;
      }
      if (active) {
        setProfile(p);
        setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [escrowId, role]);

  if (!ready) {
    return <Text style={styles.loading}>Loading…</Text>;
  }

  // Last-resort fallback when no realtor profile is reachable at all:
  // generic, name-only, no gendered pronouns.
  const name = profile?.name?.trim() || 'Your realtor';
  // Remote-first photo/banner (the synced-photo contract): the server
  // Storage URL is preferred, the device-local file is the offline fallback.
  const photoUri = displayPhotoUri(profile);
  const bannerUri = displayBannerUri(profile);

  return (
    <>
      <CelebrationCard clientName={clientName} name={name} bannerUri={bannerUri} />
      <View style={styles.cta}>
        <PrimaryButton title="View my escrow" onPress={onViewEscrow} />
      </View>
      <TextLink title="Not your escrow? Start over" onPress={onStartOver} />
      <View style={styles.realtorFoot} testID="celebration-realtor">
        <Text style={styles.realtorLabel}>{celebrationRealtorLabel()}</Text>
        <Pressable
          onPress={onProfilePress}
          accessibilityRole="button"
          accessibilityLabel={`View ${name}'s profile`}
          style={styles.realtorPhotoBtn}
          testID="celebration-realtor-photo"
        >
          {photoUri ? (
            <Image
              source={{ uri: photoUri }}
              style={styles.realtorPhoto}
              accessibilityLabel={`Photo of ${name}`}
            />
          ) : (
            <View style={[styles.realtorPhoto, styles.realtorPhotoFallback]}>
              <Text style={styles.realtorPhotoInitials}>{initialsOf(name)}</Text>
            </View>
          )}
        </Pressable>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  loading: { fontSize: 15, color: MUTED, textAlign: 'center', marginTop: 40 },
  // Celebration card (redesign, Anuraj, Sept 2026): taller, white, subtle
  // border; the banner strip is the header.
  card: {
    marginTop: 6,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: LINE,
  },
  // Banner header strip: the realtor's synced banner, cover-cropped, full
  // card width. The strip height is the single source of truth in
  // src/lib/bannerSize.ts (the banner-upload helper copy is computed from
  // it).
  bannerStrip: {
    height: CELEBRATION_BANNER.stripHeight,
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#0E3B35',
  },
  cardBody: {
    paddingTop: 18,
    paddingBottom: 26,
    paddingHorizontal: 24,
    alignItems: 'center',
  },
  kicker: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2.5,
    textTransform: 'uppercase',
    color: AMBER,
    textAlign: 'center',
  },
  headline: {
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: -0.5,
    color: INK,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 39,
  },
  sub: {
    fontSize: 17,
    fontWeight: '700',
    color: INK,
    marginTop: 14,
    textAlign: 'center',
  },
  sub2: {
    fontSize: 15,
    color: BODY,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 22.5,
  },
  // "View my escrow" sits directly below the card, pulled close to it.
  cta: { marginTop: 18 },
  realtorFoot: { marginTop: 14, alignItems: 'center' },
  realtorLabel: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    textTransform: 'uppercase',
    color: MUTED,
    marginBottom: 10,
  },
  // Realtor photo: ~124px tap target into the in-app realtor profile.
  realtorPhotoBtn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  realtorPhoto: {
    width: 124,
    height: 124,
    borderRadius: 62,
    borderWidth: 3,
    borderColor: PHOTO_BORDER,
  },
  realtorPhotoFallback: {
    backgroundColor: '#F1E9D6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  realtorPhotoInitials: { color: AMBER, fontSize: 46, fontWeight: '800' },
});
