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
//    "Hi {name}" (30/25px ink 800), the "YOUR PURCHASE"/"YOUR SALE" kicker
//    (amber) + the escrow status tag ("In progress" amber outline,
//    "Completed" filled amber), the address lines, then centered "N of N
//    steps", the progress ring (210/160px, amber-gold #E3B95C on the #E7E0D3
//    track, centered pct 44/34px ink), and the days line ("days left: N"
//    with the number ink 26/21px; amber at 7 or fewer days, red at 3 or
//    fewer; "due today" / "overdue by N day(s)" keep their treatments).
//  - 100%: the top card STAYS the same card — only the status tag flips to
//    "Completed" and the unified confetti BURST (the shared ConfettiBurst)
//    pops up from the card's bottom edge. The mid-card completion pill stays
//    visible at 100%. The ahead-of-pace pill is GONE (Anuraj's call).
//  - The "Just closed!" triumph card (TriumphCard, exported below) renders
//    BELOW the top card. The step list below the card is untouched.
//    No JUST NOW markers anywhere.
import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { initialsOf } from './ui';
import { ProgressRing } from './ProgressRing';
import { ConfettiBurst, ConfettiLayer } from './Confetti';
import { completionPill } from '../lib/pace';
import {
  CLIENT_TOPCARD_BG,
  DAYS_LEFT_COLORS,
  TOPCARD_TOKENS,
  daysLeftTone,
  topCardPill,
  topCardSizeClass,
} from '../lib/topCard';
import { escrowStatusLabel } from '../lib/clientView';
import { displayBannerUri, displayPhotoUri } from '../lib/profile';
import { colors } from '../theme';
import type { RealtorProfile } from '../lib/types';

const GOLD = '#F5C66B';
const RING_GOLD = '#E3B95C';
const AMBER = '#A86A12';
const AMBER_LIGHT = '#E0B34E';
const INK = '#211D17';
const BODY = '#5F574C';
const LINE = '#E7E0D3';
const RED = '#B23B3B';

// Branding fields (realty_group, banner_image, rating, avgDaysToClose) ride
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
   * "YOUR PURCHASE"/"YOUR SALE" kicker as "In progress" or "Completed"
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

/** The 100% status pill, shared by the mid-card slot and the triumph card. */
function CompletionPill({ text }: { text: string }) {
  return (
    <View style={styles.statusPill} testID="completion-banner">
      <View style={[styles.dot, styles.dotAccent]} />
      <Text style={styles.statusPillText}>{text}</Text>
    </View>
  );
}

// "Just closed!" triumph card, rendered BELOW the client top card at 100%
// (the top card stays the same card; only its status tag flips to
// "Completed"). Light theme (celebration redesign, Anuraj, Sept 2026):
// white card, the realtor's name as the amber kicker, "Just closed!", the
// realtor's photo, "Congratulations, checklist done. The property is yours.",
// the property address, the 100% gold ring (150px display, same r=88/stroke=24
// geometry as the 208px ring), and the ahead-of-schedule pill per the
// existing 100% rule.
export function TriumphCard({
  name,
  photoUri,
  address,
  city,
  daysToClose,
  total,
  completionText,
}: {
  name: string;
  photoUri: string | null;
  address: string;
  city: string;
  daysToClose: number;
  total: number;
  completionText?: string;
}) {
  const [cardHeight, setCardHeight] = useState(0);
  const pill = completionPill({ done: total, total, daysToClose, name });
  // The TC view passes its own completion copy; buyer/seller keep the
  // approved client-home pill text.
  const pillText = completionText ?? pill?.text ?? null;
  // Mockup screen 10 renders the 208-geometry ring at 150px display size.
  const k = 150 / 208;
  return (
    <View
      style={styles.hero}
      testID="client-topcard"
      onLayout={(e) => setCardHeight(e.nativeEvent.layout.height)}
    >
      <ConfettiLayer cardHeight={cardHeight} testID="triumph-confetti" />
      <View style={styles.triumphContent}>
        <Text style={styles.triumphKicker}>{name}</Text>
        <Text style={styles.triumphHeadline}>Just closed!</Text>
        <View style={styles.triumphPhotoWrap}>
          <View style={styles.triumphPhoto}>
            {photoUri ? (
              <Image source={{ uri: photoUri }} style={styles.triumphPhotoImg} />
            ) : (
              <Text style={styles.triumphPhotoInitials}>{initialsOf(name)}</Text>
            )}
          </View>
        </View>
        <Text style={styles.triumphText} testID="triumph-text">
          Congratulations, checklist done. The property is yours.
        </Text>
        <Text style={styles.triumphAddr} testID="triumph-address">
          {city ? `${address}, ${city}` : address}
        </Text>
        <View style={styles.triumphRingWrap}>
          <ProgressRing
            done={total}
            total={total}
            size={150}
            radius={88 * k}
            strokeWidth={24 * k}
            labelSize={32}
            trackStroke={LINE}
            progressStroke={GOLD}
            labelColor={INK}
            testID="progress-ring"
          />
        </View>
        {pillText ? (
          <View style={styles.triumphPillWrap}>
            <CompletionPill text={pillText} />
          </View>
        ) : null}
      </View>
    </View>
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

  const pill = topCardPill({ done, total, daysToClose, name });
  // 100% (Anuraj, Sept 2026): the top card stays the same card — only the
  // status tag flips to "Completed" and the unified confetti BURST pops up
  // from the card's bottom edge. The mid-card completion pill stays visible
  // at 100% (Anuraj's final call); the "Just closed!" triumph card renders
  // below the top card (see TriumphCard). The step list below the card is
  // untouched. No JUST NOW markers anywhere.
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

        {/* The mid-card completion pill stays visible at 100% (Anuraj's
            final call, Sept 2026): the ONLY per-status changes on the top
            card are the status tag flipping to "Completed" and the confetti
            burst popping from below the card. The ahead-of-pace pill is
            gone. */}
        {pill?.kind === 'completion' ? <CompletionPill text={pill.text} /> : null}
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
  // Status pill.
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.accentSoft,
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  statusPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.accent,
    lineHeight: 18.2,
    textAlign: 'center',
    flexShrink: 1,
    flexGrow: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
  },
  dotAccent: {
    backgroundColor: colors.accent,
  },
  // 100% triumph card (light theme).
  triumphContent: {
    position: 'relative',
    paddingTop: 22,
    paddingBottom: 24,
    paddingHorizontal: 20,
  },
  triumphKicker: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.8,
    color: AMBER,
    textAlign: 'center',
  },
  triumphHeadline: {
    fontSize: 34,
    fontWeight: '800',
    color: INK,
    textAlign: 'center',
    marginTop: 6,
  },
  triumphPhotoWrap: {
    alignItems: 'center',
    marginTop: 12,
  },
  triumphPhoto: {
    width: 52,
    height: 52,
    borderRadius: 26,
    borderWidth: 3,
    borderColor: colors.photoBorder,
    overflow: 'hidden',
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  triumphPhotoImg: {
    width: 46,
    height: 46,
    borderRadius: 23,
  },
  triumphPhotoInitials: {
    color: colors.accent,
    fontWeight: '800',
    fontSize: 18,
  },
  triumphText: {
    fontSize: 15,
    lineHeight: 22.5,
    color: INK,
    textAlign: 'center',
    marginTop: 10,
  },
  triumphAddr: {
    fontSize: 13,
    color: BODY,
    textAlign: 'center',
    marginTop: 4,
  },
  triumphRingWrap: {
    alignItems: 'center',
    marginTop: 10,
  },
  triumphPillWrap: {
    marginTop: 12,
  },
});
