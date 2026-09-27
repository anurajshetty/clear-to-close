// Clear to Close — client home top card, built ONCE and reused by the buyer
// and seller home views.
//
// Branding redesign (APPROVED mockup screen 7 "banner bleed" + screen 9
// "ahead of pace", Sept 26, 2026):
//  - full-bleed card: the realtor's banner photo behind everything with a dark
//    scrim so white text stays legible; brand-teal gradient fallback (drawn
//    with react-native-svg, no new native module) when no banner is set.
//  - header: "Hi {name}", "YOUR PURCHASE"/"YOUR SALE" kicker, address lines,
//    and the realtor avatar top-right opening the realtor profile.
//  - centered: "N of N steps" above the 208px gold progress ring, then the
//    days line ("days left: N" / "due today" / "overdue by N day(s)").
//  - status pill (see src/lib/pace.ts): 100% + 5 or more days left ->
//    "Checklist complete with {N} days to spare. {Name} has you ahead of
//    schedule."; 100% with fewer -> the unchanged "Congratulations, your
//    checklist is complete"; in progress and 15+ points ahead of the timeline
//    -> gold "Ahead of pace. {Name} has you {X} days ahead of schedule."
//  - "GUIDED BY" strip: the realtor's banner as the strip's own background
//    (teal gradient fallback) with a dark scrim and thin gold border;
//    realtor photo, name + realty group (or name + DRE when no group is set),
//    tagline, and Call / Text buttons (Anuraj's call, Sept 2026: the Profile
//    button was removed).
//  - 100% (APPROVED mockup screen 10 "Home at 100% · realtor triumph"): the
//    card becomes the realtor triumph — confetti (reduced-motion respected),
//    the realtor's name as the gold kicker, "Just closed!", realtor photo,
//    "Congratulations, checklist done. The property is yours.", property address,
//    the 100% gold ring, and the ahead-of-schedule pill per the 100% rule.
// The step list below the card is untouched. No JUST NOW markers anywhere.
import React, { useState } from 'react';
import { Image, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Rect, Stop } from 'react-native-svg';
import { initialsOf } from './ui';
import { ProgressRing } from './ProgressRing';
import { ConfettiLayer } from './Confetti';
import { aheadOfPace, completionPill, firstNameOf } from '../lib/pace';
import { GUIDED_BY_STRIP } from '../lib/bannerSize';
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
   * (Anuraj, Sept 2026): this is the way into the profile now that the
   * GUIDED BY "Profile" button was removed.
   */
  onProfilePress?: () => void;
  /**
   * Completion banner copy (Sept 2026, TC view). Defaults to the approved
   * client-home copy; the TC screen passes its own line.
   */
  completionText?: string;
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
  return (
    <Text style={styles.byBig} testID="days-line">
      days left: <Text style={styles.byBigNum}>{daysToClose}</Text>
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

// Screen 10 (APPROVED mockup "Home at 100% · realtor triumph", Sept 26): at
// 100% the top card becomes the realtor triumph — confetti (reduced-motion
// respected, see ConfettiLayer), the realtor's name as the gold kicker, "Just
// closed!", the realtor's photo, "Congratulations, checklist done. The
// property is yours.", the property address, the 100% gold ring (150px display, same
// r=88/stroke=24 geometry as the 208px ring), and the ahead-of-schedule
// pill per the existing 100% rule. The card keeps the brand-teal gradient
// with gold glows (mockup), not the banner photo.
function TriumphCard({
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
  // Optional completion-copy override (Sept 2026, TC view): when provided,
  // the 100% triumph pill shows this text instead of the client-home copy.
  // Absent (buyer/seller) the approved client copy renders unchanged.
  completionText,
}: ClientTopCardProps) {
  const branded = profile;
  const name = (branded?.name ?? '').trim();
  const first = firstNameOf(name) || 'your realtor';
  const phone = (branded?.phone ?? '').trim();
  const bannerUri = displayBannerUri(branded);
  const realtyGroup = (branded?.realty_group ?? '').trim();
  const dre = (branded?.dreLicense ?? '').trim();
  const tagline = (branded?.about ?? '').trim();

  // Guided-by name line (mockup screen 7): "Name · Realty group". When no
  // group is set, name + DRE only — never a dangling separator.
  const nameLine = realtyGroup
    ? `${name} · ${realtyGroup}`
    : dre
      ? `${name} · DRE #${dre}`
      : name;

  const pill = completionPill({ done, total, daysToClose, name });
  const pace = pill ? { kind: 'none' as const } : aheadOfPace({ done, total, openDate, closeDate });

  // 100%: the top card becomes the realtor triumph (screen 10).
  const isComplete = total > 0 && done >= total;
  if (isComplete) {
    return (
      <TriumphCard
        name={name}
        photoUri={displayPhotoUri(branded)}
        address={address}
        city={city}
        daysToClose={daysToClose}
        total={total}
        completionText={completionText}
      />
    );
  }

  const call = () => {
    if (phone) Linking.openURL(`tel:${phone}`);
  };
  const text = () => {
    if (phone) Linking.openURL(`sms:${phone}`);
  };

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
    <View style={styles.hero} testID="client-topcard">
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
      {/* Dark scrim over a photo so white text stays legible on any image. */}
      {bannerUri ? <View style={styles.scrim} /> : null}

      <View style={styles.content}>
        <View style={styles.topRow}>
          <View style={styles.head}>
            <Text style={styles.greeting}>{greeting}</Text>
            <Text style={styles.kickerGold}>{kicker.toUpperCase()}</Text>
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

        {pill ? (
          <CompletionPill text={pill.text} />
        ) : pace.kind === 'ahead' ? (
          <View style={styles.pacePill} testID="pace-pill">
            <View style={[styles.dot, styles.dotGold]} />
            <Text style={styles.pacePillText}>
              {`Ahead of pace. ${first} has you ${pace.daysAhead} ${
                pace.daysAhead === 1 ? 'day' : 'days'
              } ahead of schedule.`}
            </Text>
          </View>
        ) : null}

        <View style={styles.guided} testID="guided-by">
          {bannerUri ? (
            <Image
              source={{ uri: bannerUri }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              testID="guided-banner"
            />
          ) : (
            <TealGradientFallback testID="guided-gradient" />
          )}
          <View style={styles.guidedScrim} />
          <View style={styles.guidedRow}>
            <View style={styles.guidedAvatar}>
              {avatarPhoto ? (
                <Image source={{ uri: avatarPhoto }} style={styles.guidedAvatarImg} />
              ) : (
                <Text style={styles.guidedAvatarInitials}>{initialsOf(name)}</Text>
              )}
            </View>
            <View style={styles.guidedText}>
              <Text style={styles.guidedKicker}>GUIDED BY</Text>
              <Text style={styles.guidedName}>{nameLine}</Text>
              {tagline ? <Text style={styles.tagline}>{`"${tagline}"`}</Text> : null}
            </View>
          </View>
          {phone ? (
            <View style={styles.btnRow}>
              <Pressable
                onPress={call}
                accessibilityRole="button"
                accessibilityLabel={`Call ${name} at ${phone}`}
                style={styles.callBtn}
                testID="guided-call"
              >
                <Text style={styles.callBtnText}>Call</Text>
              </Pressable>
              <Pressable
                onPress={text}
                accessibilityRole="button"
                accessibilityLabel={`Text ${name} at ${phone}`}
                style={styles.ghostBtn}
                testID="guided-text"
              >
                <Text style={styles.ghostBtnText}>Text</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  // Full-bleed banner card (mockup screen 7).
  hero: {
    marginTop: 14,
    marginBottom: 18,
    borderRadius: 26,
    overflow: 'hidden',
    position: 'relative',
  },
  scrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)',
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
  kickerGold: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    color: GOLD,
    marginBottom: 4,
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
  // "Guided by" strip: the realtor's banner as its own background (teal
  // gradient fallback), dark scrim for legibility, thin gold border.
  guided: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(245,198,107,0.7)',
    padding: GUIDED_BY_STRIP.stripPadding,
    marginTop: 12,
  },
  guidedScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  guidedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  guidedAvatar: {
    width: GUIDED_BY_STRIP.avatarSize,
    height: GUIDED_BY_STRIP.avatarSize,
    borderRadius: GUIDED_BY_STRIP.avatarSize / 2,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  guidedAvatarImg: {
    width: 42,
    height: 42,
    borderRadius: 21,
  },
  guidedAvatarInitials: {
    color: '#FFFFFF',
    fontWeight: '800',
    fontSize: 16,
  },
  guidedText: {
    flex: 1,
    minWidth: 0,
  },
  guidedKicker: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: GOLD,
  },
  guidedName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
    marginTop: 2,
  },
  tagline: {
    fontSize: 12,
    fontStyle: 'italic',
    color: FAINT,
    marginTop: 2,
  },
  btnRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: GUIDED_BY_STRIP.buttonGap,
  },
  callBtn: {
    flex: 1,
    minHeight: GUIDED_BY_STRIP.buttonHeight,
    borderRadius: 12,
    backgroundColor: GOLD,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  callBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#3A2E12',
  },
  ghostBtn: {
    flex: 1,
    minHeight: GUIDED_BY_STRIP.buttonHeight,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  ghostBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
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
