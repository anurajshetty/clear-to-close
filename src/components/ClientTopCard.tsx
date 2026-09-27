// Clear to Close — client home top card, built ONCE and reused by the buyer
// and seller home views.
//
// Built EXACTLY to the approved client-home-card sample (Anuraj, Sept 2026).
// Light theme: white card with a subtle border and a soft shadow on the
// paper screen.
//
//  - Banner header strip on top: the realtor's synced banner, cover-cropped;
//    the brand-teal gradient strip is the fallback when no banner is set.
//    The realtor's photo sits ON the banner's right side (88px at right 18
//    on large phones, 68px at right 14 on small), white 3px border, tapping
//    it opens the realtor profile in-app (the onProfilePress destination
//    the screens wire up).
//  - Responsive: two size classes from the sample's 390pt / 320pt phones,
//    flipping at the TOPCARD_BREAKPOINT midpoint (see src/lib/topCard.ts).
//    Small phones scale the banner, photo, type, spacing, and ring down so
//    nothing clips or overflows; large screens keep the full-size layout.
//  - Card body, all left-aligned except the centered steps/ring/days stack:
//    "Hi {name}" (30/25px ink 800), the "YOUR TRANSACTION" kicker (buyer
//    and seller share one kicker, Sept 2026)
//    (amber) + the escrow status tag ("In progress" amber outline,
//    "Completed" filled amber), the address lines, then centered "N of N
//    steps", the progress ring (210/160px, amber-gold #E3B95C on the #E7E0D3
//    track, centered pct 44/34px ink), and the days line ("days left: N"
//    with the number ink 26/21px; amber at 7 or fewer days, red at 3 or
//    fewer; "due today" / "overdue by N day(s)" keep their treatments).
//  - 100%: the top card STAYS the same card — only the status tag flips to
//    "Completed" and the unified confetti BURST (the shared ConfettiBurst)
//    pops up from the card's bottom edge. No pace pill, no completion pill,
//    no separate 100% triumph card (Anuraj's call, Sept 2026).
//  - The step list below the card is untouched. No JUST NOW markers
//    anywhere.
import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { initialsOf } from './ui';
import { ProgressRing } from './ProgressRing';
import { ConfettiBurst } from './Confetti';
import {
  CLIENT_TOPCARD_BG,
  DAYS_LEFT_COLORS,
  TOPCARD_TOKENS,
  daysLeftTone,
  topCardSizeClass,
} from '../lib/topCard';
import { escrowStatusLabel } from '../lib/clientView';
import { displayBannerUri, displayPhotoUri } from '../lib/profile';
import { colors } from '../theme';
import type { RealtorProfile } from '../lib/types';

const RING_GOLD = '#E3B95C';
const AMBER = '#A86A12';
const AMBER_LIGHT = '#E0B34E';
const INK = '#211D17';
const BODY = '#5F574C';
const LINE = '#E7E0D3';
const RED = '#B23B3B';

// Branding fields (realty_group, banner_image, rating) ride
// the canonical RealtorProfile now that the profile workstream has merged.
type BrandedProfile = RealtorProfile;

export type ClientTopCardProps = {
  greeting: string;
  kicker: string;
  address: string;
  city: string;
  daysToClose: number;
  done: number;
  total: number;
  profile: RealtorProfile | null;
  /**
   * Tapping the realtor photo (on the banner strip) opens the realtor
   * profile (Anuraj, Sept 2026): this is the way into the profile.
   */
  onProfilePress?: () => void;
  /**
   * Escrow lifecycle status (Sept 2026, Anuraj's call): shown next to the
   * "YOUR TRANSACTION" kicker as "In progress" or "Completed"
   * (see escrowStatusLabel). Rides in the client view since migration 0015;
   * absent (older cached views) defaults to "In progress".
   */
  status?: 'open' | 'closed' | 'cancelled';
};

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
        <LinearGradient id="topcardBannerGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <Stop offset="0%" stopColor="#0E3B36" />
          <Stop offset="55%" stopColor="#175E54" />
          <Stop offset="100%" stopColor="#2A7A6C" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill="url(#topcardBannerGrad)" />
    </Svg>
  );
}

/**
 * The realtor photo on the banner strip's right side (approved sample,
 * Anuraj, Sept 2026): the synced photo when available, otherwise the
 * amber-gold gradient circle with the realtor's initials.
 */
function BannerPhoto({
  name,
  photoUri,
  size,
  borderWidth,
  initialsSize,
}: {
  name: string;
  photoUri: string | null;
  size: number;
  borderWidth: number;
  initialsSize: number;
}) {
  const inner = size - borderWidth * 2;
  return (
    <View
      style={[
        styles.photoRing,
        { width: size, height: size, borderRadius: size / 2, borderWidth },
      ]}
    >
      {photoUri ? (
        <Image
          source={{ uri: photoUri }}
          style={{ width: inner, height: inner, borderRadius: inner / 2 }}
        />
      ) : (
        <View style={{ width: inner, height: inner, borderRadius: inner / 2, overflow: 'hidden' }}>
          <Svg width={inner} height={inner} viewBox={`0 0 ${inner} ${inner}`}>
            <Defs>
              <LinearGradient id="topcardPhotoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <Stop offset="0%" stopColor={AMBER} />
                <Stop offset="100%" stopColor={AMBER_LIGHT} />
              </LinearGradient>
            </Defs>
            <Circle cx={inner / 2} cy={inner / 2} r={inner / 2} fill="url(#topcardPhotoGrad)" />
          </Svg>
          <View style={styles.photoInitialsWrap}>
            <Text style={[styles.photoInitials, { fontSize: initialsSize }]}>
              {initialsOf(name)}
            </Text>
          </View>
        </View>
      )}
    </View>
  );
}

function DaysLine({
  daysToClose,
  daysSize,
  numSize,
}: {
  daysToClose: number;
  daysSize: number;
  numSize: number;
}) {
  if (daysToClose === 0) {
    return (
      <Text style={[styles.byBig, styles.byBigStrong, { fontSize: daysSize }]} testID="days-line">
        due today
      </Text>
    );
  }
  if (daysToClose < 0) {
    const n = Math.abs(daysToClose);
    return (
      <Text style={[styles.byBig, styles.over, { fontSize: daysSize }]} testID="days-line">
        overdue by <Text style={styles.overNum}>{n}</Text> {n === 1 ? 'day' : 'days'}
      </Text>
    );
  }
  // Days-left color thresholds (Anuraj, Sept 2026): the number is ink
  // normally, amber at 7 or fewer days, red at 3 or fewer.
  const tone = daysLeftTone(daysToClose);
  const numColor =
    tone === 'alert' ? DAYS_LEFT_COLORS.alert : tone === 'warn' ? DAYS_LEFT_COLORS.warn : DAYS_LEFT_COLORS.default;
  return (
    <Text style={[styles.byBig, { fontSize: daysSize }]} testID="days-line">
      days left: <Text style={[styles.byBigNum, { fontSize: numSize, color: numColor }]}>{daysToClose}</Text>
    </Text>
  );
}

export function ClientTopCard({
  greeting,
  kicker,
  address,
  city,
  daysToClose,
  done,
  total,
  profile,
  onProfilePress,
  status,
}: ClientTopCardProps) {
  const branded = profile;
  const name = (branded?.name ?? '').trim();

  // Responsive size class (approved sample, Anuraj, Sept 2026): the sample
  // pins exact sizes at the 390pt and 320pt phones; the class flips at the
  // TOPCARD_BREAKPOINT midpoint so small phones scale down and large
  // screens keep the full-size layout.
  const { width: screenW } = useWindowDimensions();
  const sizeClass = topCardSizeClass(screenW);
  const t = TOPCARD_TOKENS[sizeClass];

  // 100% (Anuraj, Sept 2026): the top card stays the same card — only the
  // status tag flips to "Completed" and the unified confetti BURST pops up
  // from the card's bottom edge. No pace pill, no completion pill anywhere.
  // The step list below the card is untouched. No JUST NOW markers anywhere.
  const isComplete = total > 0 && done >= total;
  const statusText = escrowStatusLabel({ done, total, status });
  const [cardW, setCardW] = useState(0);
  const [cardH, setCardH] = useState(0);

  const bannerUri = displayBannerUri(branded);
  const avatarPhoto = displayPhotoUri(branded);
  const photo = (
    <BannerPhoto
      name={name}
      photoUri={avatarPhoto}
      size={t.photo}
      borderWidth={t.photoBorder}
      initialsSize={t.photoInitials}
    />
  );

  return (
    <View
      style={styles.hero}
      testID="client-topcard"
      onLayout={(e) => {
        setCardW(e.nativeEvent.layout.width);
        setCardH(e.nativeEvent.layout.height);
      }}
    >
      {/* Banner header strip on top (approved sample, Anuraj, Sept 2026):
          the realtor's synced banner, cover-cropped; the brand-teal gradient
          strip is the fallback when no banner is uploaded. The realtor
          photo sits on the banner's right side and opens the realtor
          profile in-app. */}
      <View style={[styles.bannerStrip, { height: t.banner }]} testID="topcard-banner-header">
        {bannerUri ? (
          <Image
            source={{ uri: bannerUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            testID="topcard-banner"
          />
        ) : (
          <TealGradientFallback testID="topcard-gradient" />
        )}
        {onProfilePress ? (
          <Pressable
            onPress={onProfilePress}
            accessibilityRole="button"
            accessibilityLabel={`View ${name}'s profile`}
            style={[styles.photoBtn, { right: t.photoRight, transform: [{ translateY: -(t.photo / 2) }] }]}
            testID="topcard-banner-photo"
          >
            {photo}
          </Pressable>
        ) : (
          <View
            style={[styles.photoBtn, { right: t.photoRight, transform: [{ translateY: -(t.photo / 2) }] }]}
            testID="topcard-banner-photo"
          >
            {photo}
          </View>
        )}
      </View>

      {/* 100%: the unified confetti BURST pops up from below the top card
          (the shared ConfettiBurst — one confetti implementation, same look
          and motion everywhere; reduced-motion aware). */}
      {isComplete ? (
        <ConfettiBurst cardWidth={cardW} cardHeight={cardH} testID="topcard-confetti-burst" />
      ) : null}

      {/* Card body: all left-aligned except the centered steps/ring/days
          stack (approved sample). */}
      <View
        style={[
          styles.content,
          { paddingTop: t.bodyPadT, paddingHorizontal: t.bodyPadH, paddingBottom: t.bodyPadB },
        ]}
      >
        <Text style={[styles.greeting, { fontSize: t.greeting }]}>{greeting}</Text>
        <View style={[styles.kickerRow, { marginTop: t.kickerTop }]}>
          <Text style={[styles.kickerAmber, { fontSize: t.kicker }]}>{kicker.toUpperCase()}</Text>
          <View
            style={[
              styles.statusTag,
              statusText === 'Completed' && styles.statusTagDone,
              { paddingVertical: t.statusPadV, paddingHorizontal: t.statusPadH },
            ]}
            testID="escrow-status"
          >
            <Text
              style={[
                styles.statusTagText,
                statusText === 'Completed' && styles.statusTagTextDone,
                { fontSize: t.status },
              ]}
            >
              {statusText}
            </Text>
          </View>
        </View>
        <Text
          style={[styles.addr, { fontSize: t.addr, marginTop: t.addrTop, lineHeight: t.addr * 1.45 }]}
          testID="client-address"
        >
          {address}
        </Text>
        <Text style={[styles.addr, { fontSize: t.addr, lineHeight: t.addr * 1.45 }]} testID="client-city">
          {city}
        </Text>

        <View style={[styles.center, { marginTop: t.stepsTop }]} testID="topcard-center">
          <Text style={[styles.ringCap, { fontSize: t.steps }]} testID="steps-caption">{`${done} of ${total} steps`}</Text>
          <View style={{ marginTop: t.ringTop }}>
            <ProgressRing
              done={done}
              total={total}
              size={t.ring}
              radius={t.ringRadius}
              strokeWidth={t.ringStroke}
              labelSize={t.pct}
              trackStroke={LINE}
              progressStroke={RING_GOLD}
              labelColor={INK}
              testID="progress-ring"
            />
          </View>
          <View style={{ marginTop: t.daysTop }}>
            <DaysLine daysToClose={daysToClose} daysSize={t.days} numSize={t.daysNum} />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // Top card (approved client-home-card sample, Anuraj, Sept 2026): white
  // card with a subtle border and a soft shadow on the paper screen.
  hero: {
    marginTop: 14,
    marginBottom: 18,
    borderRadius: 24,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: CLIENT_TOPCARD_BG,
    borderWidth: 1,
    borderColor: LINE,
    shadowColor: '#211D17',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.07,
    shadowRadius: 24,
    elevation: 6,
  },
  // Banner header strip: the realtor's synced banner, cover-cropped, full
  // card width; the brand-teal gradient is the fallback. The card's rounded
  // top corners come from `overflow: hidden` on the hero above.
  bannerStrip: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#0E3B36',
  },
  // Realtor photo on the banner's right side: vertically centered on the
  // strip, white ring, opens the realtor profile in-app (Anuraj, Sept 2026).
  photoBtn: {
    position: 'absolute',
    top: '50%',
  },
  photoRing: {
    borderColor: '#FFFFFF',
    backgroundColor: AMBER,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photoInitialsWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoInitials: {
    color: '#FFFFFF',
    fontWeight: '800',
  },
  // Card body: left-aligned content; the steps/ring/days stack centers.
  content: {},
  greeting: {
    fontWeight: '800',
    color: INK,
    letterSpacing: -0.5,
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'wrap',
  },
  kickerAmber: {
    fontWeight: '700',
    letterSpacing: 2,
    color: AMBER,
  },
  // Escrow status tag next to the kicker (Anuraj, Sept 2026): "In progress"
  // reads as an amber outline on the light card; "Completed" fills amber so
  // the 100% state is unmistakable.
  statusTag: {
    borderWidth: 1.5,
    borderColor: AMBER,
    borderRadius: 999,
  },
  statusTagText: {
    fontWeight: '700',
    letterSpacing: 1.5,
    color: AMBER,
  },
  statusTagDone: {
    backgroundColor: AMBER,
    borderColor: AMBER,
  },
  statusTagTextDone: {
    color: '#FFFFFF',
  },
  addr: {
    fontWeight: '400',
    color: BODY,
  },
  // Centered stack: steps count above the ring, days line below.
  center: {
    alignItems: 'center',
  },
  ringCap: {
    fontWeight: '600',
    color: BODY,
  },
  byBig: {
    fontWeight: '400',
    color: BODY,
    textAlign: 'center',
  },
  byBigStrong: {
    fontWeight: '700',
    color: INK,
  },
  byBigNum: {
    fontWeight: '800',
    color: INK,
    letterSpacing: -0.52,
  },
  over: {
    color: RED,
    fontWeight: '700',
  },
  overNum: {
    color: RED,
  },
  // 100% triumph card removed (Anuraj, Sept 2026): the completed state is
  // just the top card (status tag "Completed") with the confetti burst.
});
