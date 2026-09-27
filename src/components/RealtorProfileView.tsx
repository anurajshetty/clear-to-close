// Clear to Close — shared realtor profile content (Sept 2026).
//
// The profile body shared by the PUBLIC profile page (app/realtor/[id].tsx)
// and the IN-APP realtor profile (app/realtor-profile.tsx, opened from the
// redeem celebration): photo, name, branded subline, about, areas served,
// and — on the public page — the public stats (Years in / Avg days to
// close / Client rating) and client reviews. The in-app profile (APPROVED
// v3, Sept 2026) renders the `inApp` variant: big photo overlapping the
// banner strip, stats pared to Years in only, no reviews section. Built
// ONCE and reused — never a divergent copy.
//
// The two surfaces differ only in their chrome: the public page wraps this
// in its responsive column with Share / Start-your-escrow buttons; the
// in-app screen renders a banner strip with the back chevron overlaid
// above this content and Call / Text buttons below. Those differences ride
// the `header` / `footer` slots and the `variant` prop so the profile
// content itself cannot drift.
import React, { type ReactNode } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { realtorSubline } from '../lib/profile';
import { initialsOf } from './ui';
import { colors, radius } from '../theme';
import type { RealtorProfile, Review } from '../lib/types';

const GOLD = '#E8A93D';

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value || '·'}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Stars({ stars }: { stars: number }) {
  const full = Math.max(0, Math.min(5, Math.round(stars)));
  return (
    <Text style={styles.stars} accessibilityLabel={`${stars} out of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Text key={n} style={{ color: n <= full ? GOLD : '#D8CFBE' }}>
          ★
        </Text>
      ))}
    </Text>
  );
}

function ReviewCard({ review }: { review: Review }) {
  return (
    <View style={styles.reviewCard}>
      <Stars stars={review.stars} />
      {review.text.trim().length > 0 ? (
        <Text style={styles.reviewText}>“{review.text.trim()}”</Text>
      ) : null}
      <Text style={styles.reviewWho}>{review.clientName}</Text>
    </View>
  );
}

export function RealtorProfileView({
  profile,
  header,
  footer,
  testID,
  variant = 'public',
}: {
  profile: RealtorProfile;
  /** Rendered above the profile hero (e.g. a top bar with a back chevron). */
  header?: ReactNode;
  /** Rendered below the reviews (e.g. action buttons). */
  footer?: ReactNode;
  testID?: string;
  /**
   * 'public' — the full public profile: photo, name, subline, about, all
   * three stats (Years in / Avg days to close / Client rating), areas, and
   * client reviews.
   *
   * 'inApp' — the in-app profile opened from the redeem celebration
   * (APPROVED v3, Sept 2026): the route renders a banner strip above this
   * content, so the hero photo is big (140px) and overlaps below the
   * banner; stats are pared to Years in only; the "What clients say"
   * reviews section is removed. Name, subline, about, and areas are
   * unchanged from the public profile.
   */
  variant?: 'public' | 'inApp';
}) {
  const inApp = variant === 'inApp';
  const areas = (profile.areasServed ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const subline = realtorSubline(profile);
  const ratingText =
    profile.rating !== null && Number.isFinite(profile.rating)
      ? (profile.rating as number).toFixed(1)
      : '';

  return (
    <View testID={testID}>
      {header}
      <View style={[styles.hero, inApp && styles.heroOverlap]}>
        {profile.photoUri ? (
          <Image
            source={{ uri: profile.photoUri }}
            style={inApp ? styles.photoLarge : styles.photo}
            testID="realtor-profile-photo"
            accessibilityLabel={`${profile.name}'s photo`}
          />
        ) : (
          <View
            style={[inApp ? styles.photoLarge : styles.photo, styles.photoFallback]}
            testID="realtor-profile-photo"
          >
            <Text style={inApp ? styles.initialsLarge : styles.initials}>
              {initialsOf(profile.name)}
            </Text>
          </View>
        )}
        <Text style={styles.name} testID="realtor-profile-name">
          {profile.name}
        </Text>
        {subline ? (
          <Text style={styles.meta} testID="realtor-profile-subline">
            {subline}
          </Text>
        ) : null}
        {profile.about.trim().length > 0 ? (
          <Text style={styles.tagline} testID="realtor-profile-about">
            “{profile.about.trim()}”
          </Text>
        ) : null}
      </View>

      {inApp ? (
        <View style={styles.statSingleRow} testID="realtor-profile-stats">
          <View style={styles.statSingle}>
            <Text style={styles.statSingleValue}>{profile.yearsExperience.trim() || '·'}</Text>
            <Text style={styles.statSingleLabel}>Years in</Text>
          </View>
        </View>
      ) : (
        <View style={styles.statRow} testID="realtor-profile-stats">
          <Stat value={profile.yearsExperience.trim()} label="Years in" />
          <Stat value={profile.avgDaysToClose.trim()} label="Avg days to close" />
          <Stat value={ratingText} label="Client rating" />
        </View>
      )}

      {areas.length > 0 ? (
        <View style={styles.section} testID="realtor-profile-areas">
          <Text style={styles.sectionTitle}>Areas I serve</Text>
          <View style={styles.chips}>
            {areas.map((a) => (
              <View key={a} style={styles.chip}>
                <Text style={styles.chipText}>{a}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {!inApp && (
        <View style={styles.section} testID="realtor-profile-reviews">
          <Text style={styles.sectionTitle}>What clients say</Text>
          {profile.reviews.length === 0 ? (
            <Text style={styles.noReviews}>No reviews yet.</Text>
          ) : (
            profile.reviews.map((r) => <ReviewCard key={r.id} review={r} />)
          )}
        </View>
      )}

      {footer}
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', marginBottom: 18 },
  // In-app profile (v3): the hero pulls up over the banner strip rendered
  // above by the route, and the photo is big (140px).
  heroOverlap: { marginTop: -52, zIndex: 1 },
  photo: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.accentSoft },
  photoLarge: {
    width: 140,
    height: 140,
    borderRadius: 70,
    borderWidth: 4,
    borderColor: colors.paper,
    backgroundColor: colors.accentSoft,
    shadowColor: '#000',
    shadowOpacity: 0.15,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 32, fontWeight: '800', color: colors.accent },
  initialsLarge: { fontSize: 52, fontWeight: '800', color: colors.accent },
  name: { fontSize: 21, fontWeight: '800', color: colors.ink, marginTop: 12, textAlign: 'center' },
  meta: { fontSize: 14, color: colors.body, marginTop: 6, textAlign: 'center' },
  tagline: {
    fontSize: 15,
    fontStyle: 'italic',
    color: colors.body,
    marginTop: 10,
    textAlign: 'center',
    lineHeight: 22,
  },
  statRow: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: radius.card,
    paddingVertical: 16,
    paddingHorizontal: 8,
    marginBottom: 18,
  },
  stat: { flex: 1, alignItems: 'center', paddingHorizontal: 4 },
  statValue: { fontSize: 22, fontWeight: '800', color: colors.ink },
  statLabel: { fontSize: 11.5, color: colors.muted, marginTop: 4, textAlign: 'center' },
  // In-app profile (v3): stats pared to Years in only — a single centered
  // white card.
  statSingleRow: { alignItems: 'center', marginTop: 20, marginBottom: 18 },
  statSingle: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 34,
    alignItems: 'center',
  },
  statSingleValue: { fontSize: 19, fontWeight: '800', color: colors.ink },
  statSingleLabel: { fontSize: 11.5, color: colors.muted, marginTop: 3 },
  section: { marginBottom: 18 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    color: colors.accent,
    marginBottom: 10,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    backgroundColor: colors.accentSoft,
    borderRadius: radius.pill,
    paddingVertical: 8,
    paddingHorizontal: 14,
  },
  chipText: { fontSize: 13.5, fontWeight: '600', color: colors.accent },
  reviewCard: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    padding: 16,
    marginBottom: 12,
  },
  stars: { fontSize: 16, letterSpacing: 2 },
  reviewText: { fontSize: 14.5, color: colors.ink, lineHeight: 21, marginTop: 8 },
  reviewWho: { fontSize: 13, color: colors.muted, marginTop: 8 },
  noReviews: { fontSize: 14, color: colors.muted },
});
