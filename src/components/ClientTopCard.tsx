// Clear to Close — client home top card, built ONCE and reused by the buyer
// and seller home views.
//
// Branding redesign (APPROVED mockup screen 7 "banner bleed" + screen 9
// "ahead of pace", Sept 26, 2026), with the correction pass (Anuraj's call,
// Sept 2026):
//  - solid dark teal (#011E1D) card background; the realtor's banner photo
//    is a header strip at the very TOP of the card (brand-teal gradient
//    strip fallback, drawn with react-native-svg, no new native module,
//    when no banner is set). All existing content sits below the banner:
//    "Hi {name}", "YOUR PURCHASE"/"YOUR SALE" + status tag, address lines,
//    realtor avatar top-right opening the realtor profile, then centered
//    "N of N steps" above the 208px gold progress ring, the days line
//    ("days left: N" / "due today" / "overdue by N day(s)"), and the
//    completion/ahead-of-pace pill below the ring.
//  - days-left number colors: default (white) normally, yellow at 7 or
//    fewer days, red at 3 or fewer (see daysLeftTone in src/lib/topCard).
//  - status pill (see src/lib/pace.ts + topCardPill in src/lib/topCard.ts):
//    100% + 5 or more days left -> "Checklist complete with {N} days to
//    spare. {Name} has you ahead of schedule."; 100% with fewer -> the
//    unchanged "Congratulations, your checklist is complete"; in progress
//    and 15+ points ahead of the timeline -> gold "Ahead of pace. {Name} has
//    you {X} days ahead of schedule."
//  - status tag next to the "YOUR PURCHASE"/"YOUR SALE" kicker: the escrow
//    lifecycle status ("In progress" or "Completed", see
//    escrowStatusLabel in src/lib/clientView.ts — it mirrors the
//    get_client_view status semantics, defaulting to "In progress").
//  - no GUIDED BY strip (Anuraj's call, Sept 2026): the strip was removed;
//    the realtor profile stays reachable through the top-right avatar.
//  - 100%: the top card STAYS the same card — only the status tag flips to
//    "Completed" and the unified confetti BURST (the shared ConfettiBurst)
//    pops up from the card's bottom edge. The mid-card completion/pace pill
//    stays visible at 100% (Anuraj's final call, Sept 2026). The "Just
//    closed!" triumph card (TriumphCard, exported below) renders BELOW the
//    top card, unchanged, followed by the review/share section. The step list
//    below the card is untouched. No JUST NOW markers anywhere.
//  - 100% triumph (APPROVED mockup screen 10 "Home at 100% · realtor triumph"):
//    rendered below the top card — confetti (reduced-motion respected), the
//    realtor's name as the gold kicker, "Just closed!", realtor photo,
//    "Congratulations, checklist done. The property is yours.", property address,
//    the 100% gold ring, and the ahead-of-schedule pill per the 100% rule.
import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { initialsOf } from './ui';
import { ProgressRing } from './ProgressRing';
import { ConfettiBurst, ConfettiLayer } from './Confetti';
import { completionPill, firstNameOf } from '../lib/pace';
import { CLIENT_TOPCARD_BG, DAYS_LEFT_COLORS, daysLeftTone, topCardPill } from '../lib/topCard';
import { TOPCARD_BANNER_HEADER } from '../lib/bannerSize';
import { escrowStatusLabel } from '../lib/clientView';
import { displayBannerUri, displayPhotoUri } from '../lib/profile';
import type { RealtorProfile } from '../lib/types';

const GOLD = '#F5C66B';
const CREAM = '#EAF3F0';
const FAINT = '#D9E8E2';
const OVERDUE = '#F0A0A0';

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
  openDate?: string;
  closeDate?: string;
  profile: RealtorProfile | null;
  /**
   * Tapping the realtor avatar (top-right) opens the realtor profile
   * (Anuraj, Sept 2026): this is the way into the profile.
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

function DaysLine({ daysToClose }: { daysToClose: number }) {
  if (daysToClose === 0) {
    return (
      <Text style={[styles.byBig, styles.byBigStrong]} testID="days-line">
        due today
      </Text>
    );
  }
  if (daysToClose < 0) {
    const n = Math.abs(daysToClose);
    return (
      <Text style={[styles.byBig, styles.over]} testID="days-line">
        overdue by <Text style={styles.overNum}>{n}</Text> {n === 1 ? 'day' : 'days'}
      </Text>
    );
  }
  // Days-left color thresholds (Anuraj, Sept 2026): the number is the default
  // (white) color normally, yellow at 7 or fewer days, red at 3 or fewer.
  const tone = daysLeftTone(daysToClose);
  const numColor =
    tone === 'alert' ? DAYS_LEFT_COLORS.alert : tone === 'warn' ? DAYS_LEFT_COLORS.warn : DAYS_LEFT_COLORS.default;
  return (
    <Text style={styles.byBig} testID="days-line">
      days left: <Text style={[styles.byBigNum, { color: numColor }]}>{daysToClose}</Text>
    </Text>
  );
}

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
        <LinearGradient id="topcardTeal" x1="0.25" y1="0" x2="0.75" y2="1">
          <Stop offset="0" stopColor="#0E3B35" />
          <Stop offset="0.45" stopColor="#175E54" />
          <Stop offset="0.75" stopColor="#1F7A6B" />
          <Stop offset="1" stopColor="#2E8B7A" />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill="url(#topcardTeal)" />
    </Svg>
  );
}

/** The 100% status pill, shared by the mid-escrow card and the triumph card. */
function CompletionPill({ text }: { text: string }) {
  return (
    <View style={styles.statusPill} testID="completion-banner">
      <View style={[styles.dot, styles.dotLight]} />
      <Text style={styles.statusPillText}>{text}</Text>
    </View>
  );
}

/** Gold radial glows over the teal gradient on the 100% triumph card. */
function GoldGlows() {
  return (
    <Svg
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
      testID="triumph-glows"
    >
      <Defs>
        <RadialGradient id="triumphGlowA" cx="80%" cy="15%" r="35%">
          <Stop offset="0%" stopColor="#F5C66B" stopOpacity="0.28" />
          <Stop offset="100%" stopColor="#F5C66B" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient id="triumphGlowB" cx="12%" cy="85%" r="30%">
          <Stop offset="0%" stopColor="#F5C66B" stopOpacity="0.28" />
          <Stop offset="100%" stopColor="#F5C66B" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Rect x="0" y="0" width="100" height="100" fill="url(#triumphGlowA)" />
      <Rect x="0" y="0" width="100" height="100" fill="url(#triumphGlowB)" />
    </Svg>
  );
}

// Screen 10 (APPROVED mockup "Home at 100% · realtor triumph", Sept 26).
// Rendered BELOW the client top card at 100% (the top card stays the same
// card; only its status tag flips to "Completed"). UNCHANGED by the guided-by
// removal (Anuraj, Sept 2026): confetti (reduced-motion respected, see
// ConfettiLayer), the realtor's name as the gold kicker, "Just closed!", the
// realtor's photo, "Congratulations, checklist done. The property is yours.",
// the property address, the 100% gold ring (150px display, same r=88/stroke=24
// geometry as the 208px ring), and the ahead-of-schedule pill per the
// existing 100% rule. The card keeps the brand-teal gradient with gold glows
// (mockup), not the banner photo.
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
      <TealGradientFallback testID="triumph-gradient" />
      <GoldGlows />
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
            trackStroke="rgba(255,255,255,0.22)"
            progressStroke={GOLD}
            labelColor="#FFFFFF"
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
  openDate,
  closeDate,
  profile,
  onProfilePress,
  status,
}: ClientTopCardProps) {
  const branded = profile;
  const name = (branded?.name ?? '').trim();
  const first = firstNameOf(name) || 'your realtor';
  const bannerUri = displayBannerUri(branded);

  const pill = topCardPill({ done, total, daysToClose, name, openDate, closeDate });
  // 100% (Anuraj, Sept 2026): the top card stays the same card — only the
  // status tag flips to "Completed" and the unified confetti BURST pops up
  // from the card's bottom edge. The mid-card completion/pace pill stays
  // visible at 100% (Anuraj's final call); the "Just closed!" triumph card
  // renders below the top card (see TriumphCard), unchanged.
  const isComplete = total > 0 && done >= total;
  const statusText = escrowStatusLabel({ done, total, status });
  const [cardW, setCardW] = useState(0);
  const [cardH, setCardH] = useState(0);

  const avatarPhoto = displayPhotoUri(branded);
  const avatar = (
    <View style={styles.avatarCircle}>
      {avatarPhoto ? (
        <Image source={{ uri: avatarPhoto }} style={styles.avatarImg} />
      ) : (
        <Text style={styles.avatarInitials}>{initialsOf(name)}</Text>
      )}
    </View>
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
      {/* Banner header strip at the very TOP of the card (Anuraj, Sept 2026):
          the realtor's synced banner image, cover-cropped; the brand-teal
          gradient strip is the fallback when no banner is uploaded. All
          card content sits below it. */}
      <View style={styles.bannerHeader} testID="topcard-banner-header">
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
      </View>

      {/* 100%: the unified confetti BURST pops up from below the top card
          (the shared ConfettiBurst — one confetti implementation, same look
          and motion everywhere; reduced-motion aware). */}
      {isComplete ? (
        <ConfettiBurst cardWidth={cardW} cardHeight={cardH} testID="topcard-confetti-burst" />
      ) : null}

      <View style={styles.content}>
        <View style={styles.topRow}>
          <View style={styles.head}>
            <Text style={styles.greeting}>{greeting}</Text>
            <View style={styles.kickerRow}>
              <Text style={styles.kickerGold}>{kicker.toUpperCase()}</Text>
              <View
                style={[styles.statusTag, statusText === 'Completed' && styles.statusTagDone]}
                testID="escrow-status"
              >
                <Text
                  style={[styles.statusTagText, statusText === 'Completed' && styles.statusTagTextDone]}
                >
                  {statusText.toUpperCase()}
                </Text>
              </View>
            </View>
            <Text style={styles.addr} testID="client-address">
              {address}
            </Text>
            <Text style={styles.addr} testID="client-city">
              {city}
            </Text>
          </View>
          {onProfilePress ? (
            <Pressable
              onPress={onProfilePress}
              accessibilityRole="button"
              accessibilityLabel={`View ${name}'s profile`}
              style={styles.avatarBtn}
              testID="greeting-avatar"
            >
              {avatar}
            </Pressable>
          ) : (
            <View style={styles.avatarBtn}>{avatar}</View>
          )}
        </View>

        <View style={styles.center} testID="topcard-center">
          <Text style={styles.ringCap} testID="steps-caption">{`${done} of ${total} steps`}</Text>
          <ProgressRing
            done={done}
            total={total}
            size={208}
            radius={88}
            strokeWidth={24}
            labelSize={44}
            trackStroke="rgba(255,255,255,0.22)"
            progressStroke={GOLD}
            labelColor="#FFFFFF"
            testID="progress-ring"
          />
          <DaysLine daysToClose={daysToClose} />
        </View>

        {/* The mid-card completion/pace pill stays visible at 100% (Anuraj's
            final call, Sept 2026): the ONLY per-status changes on the top
            card are the status tag flipping to "Completed" and the confetti
            burst popping from below the card. */}
        {pill?.kind === 'completion' ? (
          <CompletionPill text={pill.text} />
        ) : pill?.kind === 'pace' ? (
          <View style={styles.pacePill} testID="pace-pill">
            <View style={[styles.dot, styles.dotGold]} />
            <Text style={styles.pacePillText}>
              {`Ahead of pace. ${first} has you ${pill.daysAhead} ${
                pill.daysAhead === 1 ? 'day' : 'days'
              } ahead of schedule.`}
            </Text>
          </View>
        ) : null}
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  // Top card (correction pass, Anuraj, Sept 2026): solid dark teal (#011E1D)
  // background; the realtor's banner is a header strip at the very top of
  // the card (brand-teal gradient strip fallback when no banner), with all
  // content below it.
  hero: {
    marginTop: 14,
    marginBottom: 18,
    borderRadius: 26,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: CLIENT_TOPCARD_BG,
  },
  // Banner header strip: realtor's synced banner, cover-cropped, full card
  // width; the card's rounded top corners come from `overflow: hidden` above.
  bannerHeader: {
    height: TOPCARD_BANNER_HEADER.stripHeight,
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#0E3B35',
  },
  content: {
    paddingTop: 22,
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  // Header: greeting block + realtor avatar side by side.
  topRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 12,
  },
  head: {
    flex: 1,
    minWidth: 0,
  },
  greeting: {
    fontSize: 27,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: -0.27,
    marginBottom: 6,
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  kickerGold: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    color: GOLD,
  },
  // Escrow status tag next to the kicker (Anuraj, Sept 2026): "In progress"
  // reads as a gold outline on the dark card; "Completed" fills gold so the
  // 100% state is unmistakable.
  statusTag: {
    borderWidth: 1,
    borderColor: 'rgba(245,198,107,0.7)',
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  statusTagText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: GOLD,
  },
  statusTagDone: {
    backgroundColor: GOLD,
    borderColor: GOLD,
  },
  statusTagTextDone: {
    color: '#011E1D',
  },
  addr: {
    fontSize: 14,
    fontWeight: '400',
    color: CREAM,
    lineHeight: 20,
  },
  // Realtor avatar: 48px tap target at the greeting level -> the realtor
  // profile (Anuraj, Sept 2026).
  avatarBtn: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: {
    width: 44,
    height: 44,
    borderRadius: 22,
  },
  avatarInitials: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 17,
  },
  // Centered stack: steps count above the 208px gold ring, days line below.
  center: {
    alignItems: 'center',
    marginTop: 14,
  },
  ringCap: {
    fontSize: 13,
    fontWeight: '600',
    color: FAINT,
    marginBottom: 10,
  },
  byBig: {
    fontSize: 15,
    fontWeight: '600',
    color: FAINT,
    textAlign: 'center',
    marginTop: 8,
  },
  byBigStrong: {
    fontWeight: '700',
    color: '#FFFFFF',
  },
  byBigNum: {
    fontSize: 26,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: -0.52,
  },
  over: {
    color: OVERDUE,
    fontWeight: '700',
  },
  overNum: {
    color: OVERDUE,
  },
  // Status pills.
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  statusPillText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
    lineHeight: 18.2,
    textAlign: 'center',
    flexShrink: 1,
    flexGrow: 1,
  },
  // Gold ahead-of-pace pill (mockup screen 9): praise, distinct from the
  // neutral status pill.
  pacePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(245,198,107,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(245,198,107,0.65)',
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  pacePillText: {
    fontSize: 13,
    fontWeight: '700',
    color: GOLD,
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
  dotLight: {
    backgroundColor: '#FFFFFF',
  },
  dotGold: {
    backgroundColor: GOLD,
  },
  // 100% triumph card (mockup screen 10).
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
    color: GOLD,
    textAlign: 'center',
  },
  triumphHeadline: {
    fontSize: 34,
    fontWeight: '800',
    color: '#FFFFFF',
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
    borderColor: GOLD,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  triumphPhotoImg: {
    width: 46,
    height: 46,
    borderRadius: 23,
  },
  triumphPhotoInitials: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 18,
  },
  triumphText: {
    fontSize: 15,
    lineHeight: 22.5,
    color: '#FFFFFF',
    textAlign: 'center',
    marginTop: 10,
  },
  triumphAddr: {
    fontSize: 13,
    color: FAINT,
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
