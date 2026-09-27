// Clear to Close — client home top card, built ONCE and reused by the buyer
// and seller home views.
//
// Celebration redesign (Anuraj's call, Sept 2026): ALL client cards are back
// on the LIGHT theme (paper #F5F1EA screen, white cards) — this undoes the
// dark-teal top card. The top card is a white card with a subtle border:
// "Hi {name}", "YOUR PURCHASE"/"YOUR SALE" + the escrow status tag ("In
// progress" or "Completed", see escrowStatusLabel — it mirrors the
// get_client_view status semantics, defaulting to "In progress"), address
// lines, the realtor avatar top-right opening the realtor profile, then
// centered "N of N steps" above the 208px gold progress ring, the days line
// ("days left: N" / "due today" / "overdue by N day(s)"), and the
// completion/ahead-of-pace pill below the ring.
//  - days-left number colors: ink normally, amber at 7 or fewer days, red
//    at 3 or fewer (see daysLeftTone in src/lib/topCard).
//  - status pill (see src/lib/pace.ts + topCardPill in src/lib/topCard.ts):
//    100% + 5 or more days left -> "Checklist complete with {N} days to
//    spare. {Name} has you ahead of schedule."; 100% with fewer -> the
//    unchanged "Congratulations, your checklist is complete"; in progress
//    and 15+ points ahead of the timeline -> amber "Ahead of pace. {Name}
//    has you {X} days ahead of schedule."
//  - 100%: the top card STAYS the same card — only the status tag flips to
//    "Completed" and the unified confetti BURST (the shared ConfettiBurst)
//    pops up from the card's bottom edge. The mid-card completion/pace pill
//    stays visible at 100% (Anuraj's final call, Sept 2026). The "Just
//    closed!" triumph card (TriumphCard, exported below) renders BELOW the
//    top card on the light theme too, followed by the review/share section.
//    The step list below the card is untouched. No JUST NOW markers anywhere.
import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { initialsOf } from './ui';
import { ProgressRing } from './ProgressRing';
import { ConfettiBurst, ConfettiLayer } from './Confetti';
import { completionPill, firstNameOf } from '../lib/pace';
import { CLIENT_TOPCARD_BG, DAYS_LEFT_COLORS, daysLeftTone, topCardPill } from '../lib/topCard';
import { escrowStatusLabel } from '../lib/clientView';
import { displayPhotoUri } from '../lib/profile';
import { colors } from '../theme';
import type { RealtorProfile } from '../lib/types';

const GOLD = '#F5C66B';
const AMBER = '#A86A12';
const INK = '#211D17';
const BODY = '#5F574C';
const MUTED = '#8A8175';
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
  // Days-left color thresholds (Anuraj, Sept 2026): the number is ink
  // normally, amber at 7 or fewer days, red at 3 or fewer.
  const tone = daysLeftTone(daysToClose);
  const numColor =
    tone === 'alert' ? DAYS_LEFT_COLORS.alert : tone === 'warn' ? DAYS_LEFT_COLORS.warn : DAYS_LEFT_COLORS.default;
  return (
    <Text style={styles.byBig} testID="days-line">
      days left: <Text style={[styles.byBigNum, { color: numColor }]}>{daysToClose}</Text>
    </Text>
  );
}

/** The 100% status pill, shared by the mid-escrow card and the triumph card. */
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
  openDate,
  closeDate,
  profile,
  onProfilePress,
  status,
}: ClientTopCardProps) {
  const branded = profile;
  const name = (branded?.name ?? '').trim();
  const first = firstNameOf(name) || 'your realtor';

  const pill = topCardPill({ done, total, daysToClose, name, openDate, closeDate });
  // 100% (Anuraj, Sept 2026): the top card stays the same card — only the
  // status tag flips to "Completed" and the unified confetti BURST pops up
  // from the card's bottom edge. The mid-card completion/pace pill stays
  // visible at 100% (Anuraj's final call); the "Just closed!" triumph card
  // renders below the top card (see TriumphCard). The step list below the
  // card is untouched. No JUST NOW markers anywhere.
  const isComplete = total > 0 && done >= total;
  const statusText = escrowStatusLabel({ done, total, status });
  const [cardW, setCardW] = useState(0);
  const [cardH, setCardH] = useState(0);

  const avatarPhoto = displayPhotoUri(branded);
  const avatar = (
    <View style={styles.avatarHalo}>
      <View style={styles.avatarCircle}>
        {avatarPhoto ? (
          <Image source={{ uri: avatarPhoto }} style={styles.avatarImg} />
        ) : (
          <Text style={styles.avatarInitials}>{initialsOf(name)}</Text>
        )}
      </View>
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
              <Text style={styles.kickerAmber}>{kicker.toUpperCase()}</Text>
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
            trackStroke={LINE}
            progressStroke={GOLD}
            labelColor={INK}
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
            <View style={[styles.dot, styles.dotAmber]} />
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
  // Top card (celebration redesign, Anuraj, Sept 2026): the light theme is
  // back — white card with a subtle border on the paper screen. Layout and
  // behavior are unchanged; only the colors were adapted to read on white.
  hero: {
    marginTop: 14,
    marginBottom: 18,
    borderRadius: 26,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: CLIENT_TOPCARD_BG,
    borderWidth: 1,
    borderColor: LINE,
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
    color: INK,
    letterSpacing: -0.27,
    marginBottom: 6,
  },
  kickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  kickerAmber: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.6,
    color: AMBER,
  },
  // Escrow status tag next to the kicker (Anuraj, Sept 2026): "In progress"
  // reads as an amber outline on the light card; "Completed" fills teal so
  // the 100% state is unmistakable.
  statusTag: {
    borderWidth: 1,
    borderColor: '#D9BE85',
    borderRadius: 999,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  statusTagText: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.2,
    color: AMBER,
  },
  statusTagDone: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  statusTagTextDone: {
    color: '#FFFFFF',
  },
  addr: {
    fontSize: 14,
    fontWeight: '400',
    color: BODY,
    lineHeight: 20,
  },
  // Realtor avatar: 48px tap target at the greeting level -> the realtor
  // profile (Anuraj, Sept 2026). Soft accent halo outside the white ring.
  avatarBtn: {
    minWidth: 48,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarHalo: {
    backgroundColor: colors.accentSoft,
    borderRadius: 29,
    padding: 2,
  },
  avatarCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accent,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  avatarImg: {
    width: 42,
    height: 42,
    borderRadius: 21,
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
    color: MUTED,
    marginBottom: 10,
  },
  byBig: {
    fontSize: 15,
    fontWeight: '600',
    color: BODY,
    textAlign: 'center',
    marginTop: 8,
  },
  byBigStrong: {
    fontWeight: '700',
    color: INK,
  },
  byBigNum: {
    fontSize: 26,
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
  // Status pills.
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
  // Amber ahead-of-pace pill: praise, distinct from the neutral status pill.
  pacePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#FAF3E0',
    borderWidth: 1,
    borderColor: '#E4C878',
    borderRadius: 14,
    paddingVertical: 11,
    paddingHorizontal: 14,
    marginTop: 14,
  },
  pacePillText: {
    fontSize: 13,
    fontWeight: '700',
    color: AMBER,
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
  dotAmber: {
    backgroundColor: AMBER,
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
