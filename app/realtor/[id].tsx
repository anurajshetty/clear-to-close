// Clear to Close — PUBLIC realtor profile page (approved branding mockup screen 2).
// Route: /realtor/<realtor-id>. PUBLIC: opens for anyone, no login required,
// no app required. Fully responsive: a centered column (max 640px) that is
// full-width on phones, correct in portrait and landscape.
//
// Data comes from the get_public_profile RPC via the anon key. The root
// layout's boot redirect skips this route (see app/_layout.tsx).
// The profile body is the shared RealtorProfileView
// (src/components/RealtorProfileView.tsx) — the same content the in-app
// profile screen shows. Copy: realtor by name only, no gendered pronouns,
// no em dashes.
import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
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
import { RealtorProfileView } from '../../src/components/RealtorProfileView';
import { colors, radius } from '../../src/theme';
import type { RealtorProfile } from '../../src/lib/types';

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
          <RealtorProfileView
            profile={profile}
            footer={
              <>
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
            }
          />
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
  name: { fontSize: 21, fontWeight: '800', color: colors.ink, marginTop: 12, textAlign: 'center' },
  meta: { fontSize: 14, color: colors.body, marginTop: 6, textAlign: 'center' },
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
