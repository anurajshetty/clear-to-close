// Clear to Close — PUBLIC realtor profile page (approved branding mockup screen 2).
// Route: /realtor/<realtor-id>. PUBLIC: opens for anyone, no login required,
// no app required. Fully responsive: a centered column (max 640px) that is
// full-width on phones, correct in portrait and landscape.
//
// Data comes from the get_public_profile RPC via the anon key. The root
// layout's boot redirect skips this route (see app/_layout.tsx).
// Copy: realtor by name only, no gendered pronouns, no em dashes.
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getSupabase } from '../../src/lib/supabase';
import { getPublicProfile } from '../../src/lib/cloudSync';
import { realtorSubline } from '../../src/lib/profile';
import { initialsOf } from '../../src/components/ui';
import { colors, radius } from '../../src/theme';
import type { RealtorProfile, Review } from '../../src/lib/types';

const GOLD = '#E8A93D';
const GOLD_DEEP = '#7A5A1E';

/** Canonical public URL for this profile, derived from the current location
 *  so it works under any subpath (dev /, deployed /clear-to-close). */
export function publicProfileUrl(realtorId: string): string | null {
  if (Platform.OS !== 'web') return null;
  try {
    const href: string = window.location.href;
    const idx = href.indexOf('/realtor/');
    const base = idx >= 0 ? href.slice(0, idx) : href.replace(/\/$/, '');
    return `${base}/realtor/${realtorId}`;
  } catch {
    return null;
  }
}

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

export default function PublicRealtorProfile() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const raw = params.id;
  const realtorId = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw[0] : '';
  const { width } = useWindowDimensions();

  const [profile, setProfile] = useState<RealtorProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setProfile(null);
    (async () => {
      try {
        const client = getSupabase();
        const res = await getPublicProfile(client, realtorId);
        if (!active) return;
        if (res) setProfile(res.profile);
        else setFailed(true);
      } catch {
        if (active) setFailed(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [realtorId]);

  const shareProfile = useCallback(async () => {
    if (!profile) return;
    const url = publicProfileUrl(realtorId);
    const message = url
      ? `Meet ${profile.name}, my realtor: ${url}`
      : `Meet ${profile.name}, my realtor`;
    try {
      if (Platform.OS === 'web') {
        if (url) {
          await Clipboard.setStringAsync(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2500);
        }
      } else {
        await Share.share({ message, url: url ?? undefined });
      }
    } catch {
      // Sharing is best-effort; never break the page.
    }
  }, [profile, realtorId]);

  const startEscrow = useCallback(() => {
    router.push('/redeem' as never);
  }, [router]);

  const firstName = (profile?.name ?? '').trim().split(/\s+/)[0] ?? '';
  const areas = (profile?.areasServed ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  const subline = profile ? realtorSubline(profile) : '';
  const ratingText =
    profile && profile.rating !== null && Number.isFinite(profile.rating)
      ? profile.rating.toFixed(1)
      : '';
  // Narrow phones get tighter horizontal padding; the column caps at 640.
  const narrow = width < 420;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.contentWrap}>
      <View style={[styles.column, narrow && styles.columnNarrow]}>
        {!profile ? (
          failed ? (
            <View style={styles.center}>
              <Text style={styles.name}>Profile not found</Text>
              <Text style={styles.meta}>
                This link may be old or mistyped. Ask your realtor for a fresh one.
              </Text>
            </View>
          ) : (
            <View style={styles.center}>
              <ActivityIndicator size="large" color={colors.accent} />
            </View>
          )
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
              {subline ? <Text style={styles.meta}>{subline}</Text> : null}
              {profile.about.trim().length > 0 ? (
                <Text style={styles.tagline}>“{profile.about.trim()}”</Text>
              ) : null}
            </View>

            <View style={styles.statRow}>
              <Stat value={profile.yearsExperience.trim()} label="Years in" />
              <Stat value={profile.avgDaysToClose.trim()} label="Avg days to close" />
              <Stat value={ratingText} label="Client rating" />
            </View>

            {areas.length > 0 ? (
              <View style={styles.section}>
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

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>What clients say</Text>
              {profile.reviews.length === 0 ? (
                <Text style={styles.noReviews}>No reviews yet.</Text>
              ) : (
                profile.reviews.map((r) => <ReviewCard key={r.id} review={r} />)
              )}
            </View>

            <View style={styles.btnRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Share profile"
                onPress={shareProfile}
                style={({ pressed }) => [styles.shareBtn, pressed && { opacity: 0.88 }]}
              >
                <Text style={styles.shareBtnText}>
                  {copied ? 'Link copied' : 'Share profile'}
                </Text>
              </Pressable>
            </View>
            <View style={styles.btnRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  firstName ? `Start your escrow with ${firstName}` : 'Start your escrow'
                }
                onPress={startEscrow}
                style={({ pressed }) => [styles.startBtn, pressed && { opacity: 0.88 }]}
              >
                <Text style={styles.startBtnText}>
                  {firstName ? `Start your escrow with ${firstName}` : 'Start your escrow'}
                </Text>
              </Pressable>
            </View>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  contentWrap: {
    flexGrow: 1,
    alignItems: 'center',
    paddingVertical: 28,
    paddingHorizontal: 20,
  },
  // Responsive column: full width on phones, capped and centered on
  // desktop/laptop and landscape phones.
  column: { width: '100%', maxWidth: 640 },
  columnNarrow: { paddingHorizontal: 0 },
  center: { alignItems: 'center', paddingTop: 60 },
  hero: { alignItems: 'center', marginBottom: 18 },
  photo: { width: 96, height: 96, borderRadius: 48, backgroundColor: colors.accentSoft },
  photoFallback: { alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 32, fontWeight: '800', color: colors.accent },
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
  btnRow: { marginTop: 6, marginBottom: 10 },
  shareBtn: {
    backgroundColor: GOLD,
    borderRadius: radius.button,
    paddingVertical: 15,
    alignItems: 'center',
  },
  shareBtnText: { fontSize: 16, fontWeight: '800', color: GOLD_DEEP },
  startBtn: {
    backgroundColor: colors.accent,
    borderRadius: radius.button,
    paddingVertical: 15,
    alignItems: 'center',
  },
  startBtnText: { fontSize: 16, fontWeight: '800', color: '#fff' },
});
