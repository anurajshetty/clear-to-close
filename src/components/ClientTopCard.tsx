// Clear to Close — client home top card, built ONCE and reused by the buyer,
// seller, and TC home views.
//
// Built EXACTLY to the approved client-home-card + client-home-timeline
// samples (Anuraj, Sept 2026). Light theme: white card with a subtle border
// and a soft shadow on the paper screen.
//
//  - Banner header strip on top: the realtor's synced banner, cover-cropped;
//    the brand-teal gradient strip is the fallback when no banner is set.
//    The realtor's photo sits ON the banner's right side (88px at right 18
//    on large phones, 68px at right 14 on small), white 3px border, tapping
//    it opens the realtor profile in-app (the onProfilePress destination
//    the screens wire up).
//  - Viewport-fitted (Anuraj's hard requirement, Sept 2026): the ENTIRE
//    card fits within the visible screen on ANY phone size — never scroll
//    to see the card; scrolling is only for content BELOW it. Tokens
//    resolve from screen width AND height (see topCardTokens): tall screens
//    keep the exact sample sizes; shorter screens scale the internals down
//    (smaller ring, tighter spacing, smaller type).
//  - Card body, all left-aligned except the centered steps/ring/days stack:
//    "Hi {name}" (30/25px ink 800), the "YOUR TRANSACTION" kicker (buyer
//    and seller share one kicker, Sept 2026)
//    (amber) + the escrow status tag ("In progress" amber outline,
//    "Completed" filled amber), the address lines, then centered
//    "{realtor name} completed" above "N of N steps", the progress ring
//    (210/160px, amber-gold #E3B95C on the #E7E0D3 track, centered pct
//    44/34px ink), the days line ("days left: N" with the number ink
//    26/21px; amber at 7 or fewer days, red at 3 or fewer; "due today" /
//    "overdue by N day(s)" keep their treatments), and the escrow timeline
//    row: start date left, end date right, the gold elapsed bar on the same
//    line, "Escrow timeline" caption beneath (hidden when the view carries
//    no escrow dates).
//  - 100%: the top card STAYS the same card — only the status tag flips to
//    "Completed" and the unified confetti BURST (the shared ConfettiBurst)
//    pops up from the card's bottom edge. No pace pill, no completion pill,
//    no separate 100% triumph card (Anuraj's call, Sept 2026).
//  - The step list below the card is untouched. No JUST NOW markers
//    anywhere.
import React, { useState } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { ProgressRing } from './ProgressRing';
import { ConfettiBurst } from './Confetti';
import { BannerStrip } from './BannerStrip';
import {
  CLIENT_TOPCARD_BG,
  DAYS_LEFT_COLORS,
  daysLeftTone,
  escrowTimelineFill,
  formatMonthDay,
  topCardTokens,
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
  /**
   * Escrow open / target-close dates (local 'YYYY-MM-DD', from the client
   * view): feed the escrow timeline row below the days-left line. When
   * either is absent the timeline is hidden (Anuraj, Sept 2026).
   */
  openDate?: string;
  closeDate?: string;
};

/** The banner strip, photo, and their fallbacks live in the shared
 * BannerStrip component (built once, reused by the client top card and
 * the realtor home screen) — see src/components/BannerStrip.tsx. */

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
  openDate,
  closeDate,
}: ClientTopCardProps) {
  const branded = profile;
  const name = (branded?.name ?? '').trim();

  // Viewport-fitted sizing (Anuraj's hard requirement, Sept 2026): the whole
  // card must fit the visible screen on ANY phone size — never scroll to
  // see the card. Tokens resolve from screen width AND height: tall screens
  // get the exact approved-sample numbers; shorter screens scale the
  // internals down (smaller ring, tighter spacing, smaller type).
  const { width: screenW, height: screenH } = useWindowDimensions();
  const t = topCardTokens(screenW, screenH);

  // 100% (Anuraj, Sept 2026): the top card stays the same card — only the
  // status tag flips to "Completed" and the unified confetti BURST pops up
  // from the card's bottom edge. No pace pill, no completion pill anywhere.
  // The step list below the card is untouched. No JUST NOW markers anywhere.
  const isComplete = total > 0 && done >= total;
  const statusText = escrowStatusLabel({ done, total, status });
  // Escrow timeline (approved sample, Anuraj, Sept 2026): start date left,
  // end date right, the gold bar shows time elapsed. Hidden when the view
  // carries no dates.
  const timelineFill = escrowTimelineFill(openDate, closeDate);
  const timelineStart = formatMonthDay(openDate);
  const timelineEnd = formatMonthDay(closeDate);
  const [cardW, setCardW] = useState(0);
  const [cardH, setCardH] = useState(0);

  const bannerUri = displayBannerUri(branded);
  const avatarPhoto = displayPhotoUri(branded);

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
          the shared BannerStrip — the realtor's synced banner,
          cover-cropped; the brand-teal gradient strip is the fallback when
          no banner is uploaded. The realtor photo sits on the banner's
          right side and opens the realtor profile in-app. */}
      <BannerStrip
        name={name}
        bannerUri={bannerUri}
        photoUri={avatarPhoto}
        bannerHeight={t.banner}
        photoSize={t.photo}
        photoRight={t.photoRight}
        photoBorder={t.photoBorder}
        initialsSize={t.photoInitials}
        onPhotoPress={onProfilePress}
        photoAccessibilityLabel={`View ${name}'s profile`}
        stripTestID="topcard-banner-header"
        bannerTestID="topcard-banner"
        gradientTestID="topcard-gradient"
        photoTestID="topcard-banner-photo"
      />

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

        <View style={[styles.center, { marginTop: t.realtorDidTop }]} testID="topcard-center">
          {/* "{realtor name} completed" above the step count (approved
              timeline sample, Anuraj, Sept 2026). */}
          <Text style={[styles.realtorDid, { fontSize: t.realtorDid }]} testID="realtor-completed-line">
            {name ? `${name} completed` : 'Your realtor completed'}
          </Text>
          <Text
            style={[styles.ringCap, { fontSize: t.steps, marginTop: t.stepsGap }]}
            testID="steps-caption"
          >{`${done} of ${total} steps`}</Text>
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
          {/* Escrow timeline below the days-left line (approved timeline
              sample, Anuraj, Sept 2026): start date left, end date right,
              the gold bar on the same line shows time elapsed. */}
          {timelineFill !== null ? (
            <View style={[styles.timeline, { marginTop: t.timelineTop }]} testID="escrow-timeline">
              <View style={styles.timelineRow}>
                <Text style={[styles.timelineDate, { fontSize: t.timelineDate }]}>
                  {timelineStart}
                </Text>
                <View style={[styles.timelineBar, { height: t.timelineBarH }]} testID="timeline-track">
                  <Svg
                    width="100%"
                    height="100%"
                    viewBox="0 0 100 8"
                    preserveAspectRatio="none"
                  >
                    <Defs>
                      <LinearGradient id="topcardTimelineGrad" x1="0" y1="0" x2="1" y2="0">
                        <Stop offset="0%" stopColor="#E3B95C" />
                        <Stop offset="100%" stopColor="#C79A3B" />
                      </LinearGradient>
                    </Defs>
                    <Rect
                      x="0"
                      y="0"
                      width={timelineFill * 100}
                      height="8"
                      fill="url(#topcardTimelineGrad)"
                      testID="timeline-fill"
                    />
                  </Svg>
                </View>
                <Text style={[styles.timelineDate, { fontSize: t.timelineDate }]}>
                  {timelineEnd}
                </Text>
              </View>
              <Text
                style={[styles.timelineNote, { fontSize: t.timelineNote, marginTop: t.timelineNoteTop }]}
              >
                Escrow timeline
              </Text>
            </View>
          ) : null}
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
  // Centered stack: "{name} completed" above the steps count, the ring,
  // the days line, then the escrow timeline.
  center: {
    alignItems: 'center',
  },
  // "{realtor name} completed" (approved timeline sample, Anuraj, Sept
  // 2026): bold ink at the steps-caption size, centered above "N of N
  // steps".
  realtorDid: {
    fontWeight: '700',
    color: INK,
    textAlign: 'center',
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
  // Escrow timeline below the days line (approved timeline sample, Anuraj,
  // Sept 2026): start date left, end date right, the gold elapsed bar on
  // the same line between them, "Escrow timeline" caption beneath.
  timeline: {
    alignSelf: 'stretch',
    alignItems: 'center',
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'stretch',
  },
  timelineDate: {
    fontWeight: '700',
    color: BODY,
  },
  timelineBar: {
    flex: 1,
    borderRadius: 999,
    backgroundColor: '#EFE8D8',
    overflow: 'hidden',
  },
  timelineNote: {
    color: '#9A9184',
    textAlign: 'center',
  },
  // 100% triumph card removed (Anuraj, Sept 2026): the completed state is
  // just the top card (status tag "Completed") with the confetti burst.
});
