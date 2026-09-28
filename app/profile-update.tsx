// Clear to Close — realtor profile update (approved onboarding/auth ㉕ + ㉑).
// Opens from the deal-list header avatar. Same shared ProfileForm, Save
// returns to the deal list. "Log out" is a quiet row below "Change password"
// (Sept 2026): web returns to the login screen, native clears the persisted
// session fully and returns to the role-picker entry screen.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AppState,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { auth, setExpectSignOut } from '../src/lib/auth';
import { store } from '../src/lib/store-instance';
import { BackChevron, Kicker, PrimaryButton, useKeyboardHeight } from '../src/components/ui';
import { ChangePasswordSheet } from '../src/components/ChangePasswordSheet';
import { EMPTY_PROFILE_DRAFT, ProfileDraft, ProfileForm } from '../src/components/ProfileForm';
import type { RealtorProfile } from '../src/lib/types';
import { colors } from '../src/theme';

export default function ProfileUpdate() {
  const router = useRouter();
  // Keyboard avoidance (Sept 28, 2026, Anuraj: every input stays visible
  // above the keyboard). Shared pattern: bottom padding equal to the
  // keyboard height, so the focused field can scroll into view above it.
  const kbHeight = useKeyboardHeight();
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
  // Reviews live on the profile but are edited only via the review RPCs —
  // keep the loaded ones so saving the form never wipes them.
  const [keptReviews, setKeptReviews] = useState<RealtorProfile['reviews']>([]);
  const [keptRating, setKeptRating] = useState<RealtorProfile['rating']>(null);
  // Remote Storage URLs live on the profile but are written only by the
  // upload-on-save flow — keep the loaded ones so saving the form never
  // drops them (same pattern as reviews/rating).
  const [keptPhotoRemoteUrl, setKeptPhotoRemoteUrl] = useState<string | null>(null);
  const [keptBannerRemoteUrl, setKeptBannerRemoteUrl] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2400);
  }, []);

  // True once the user has touched the form since the last load — a
  // foreground refresh must never wipe in-progress edits.
  const editedRef = useRef(false);

  const patch = useCallback(
    (p: Partial<ProfileDraft>) => {
      setDraft((d) => ({ ...d, ...p }));
      if (p.name !== undefined) setNameError(null);
      editedRef.current = true;
    },
    [],
  );

  const load = useCallback(() => {
    let active = true;
    store
      .getProfile()
      .then((p) => {
        // Never overwrite in-progress typing: if the user touched the form
        // while the read was in flight, keep their draft.
        if (!p || !active || editedRef.current) return;
        setDraft({
          name: p.name ?? '',
          photoUri: p.photoUri ?? null,
          banner_image: p.banner_image ?? null,
          about: p.about ?? '',
          yearsExperience: p.yearsExperience ?? '',
          email: p.email ?? '',
          areasServed: p.areasServed ?? '',
          phone: p.phone ?? '',
          dreLicense: p.dreLicense ?? '',
          realty_group: p.realty_group ?? '',
        });
        setKeptReviews(p.reviews ?? []);
        setKeptRating(p.rating ?? null);
        setKeptPhotoRemoteUrl(p.photoRemoteUrl ?? null);
        setKeptBannerRemoteUrl(p.bannerRemoteUrl ?? null);
        setNameError(null);
        editedRef.current = false;
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useFocusEffect(load);

  // Foreground return (Sept 2026 stale-profile fix): the app may have been
  // backgrounded while the profile changed elsewhere — converge the local
  // snapshot from the server first, then reload the form unless the user
  // has unsaved edits in flight (a foreground refresh must never wipe
  // in-progress typing).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      (async () => {
        await store.refreshProfile();
        if (!editedRef.current) load();
      })();
    });
    return () => sub.remove();
  }, [load]);

  const onSave = async () => {
    if (!draft.name.trim()) {
      setNameError('Required');
      return;
    }
    setSaving(true);
    try {
      await store.saveProfile({
        name: draft.name.trim(),
        photoUri: draft.photoUri,
        photoRemoteUrl: keptPhotoRemoteUrl,
        bannerRemoteUrl: keptBannerRemoteUrl,
        banner_image: draft.banner_image,
        about: draft.about,
        yearsExperience: draft.yearsExperience,
        email: draft.email,
        areasServed: draft.areasServed,
        phone: draft.phone,
        dreLicense: draft.dreLicense,
        realty_group: draft.realty_group,
        reviews: keptReviews,
        rating: keptRating,
      });
      // A completed profile clears the onboarding "complete your profile" nudge.
      await auth.setProfileSkipped(false);
      editedRef.current = false;
      router.back();
    } finally {
      setSaving(false);
    }
  };

  const onLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setExpectSignOut(true);
    try {
      // Wipe the previous account's local cache FIRST so a different
      // realtor signing up on this device never sees it (Sept 2026).
      await store.clearLocalAccountData();
      await auth.signOut();
    } finally {
      // Web → login screen. Native → the persisted session is fully cleared
      // by signOut(); land on the role-picker entry screen.
      router.replace(auth.isWeb() ? '/login' : '/role');
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: kbHeight }]}
        keyboardShouldPersistTaps="handled"
      >
        <BackChevron label="Deal list" onPress={() => router.back()} />
        <Kicker>Your profile</Kicker>
        <Text style={styles.h1}>Update your profile</Text>
        <Text style={styles.sub}>
          This is what your clients see. Change anything below and hit Save.
        </Text>

        <ProfileForm value={draft} onChange={patch} nameError={nameError} />

        <View style={styles.cta}>
          <PrimaryButton
            title={saving ? 'Saving…' : 'Save'}
            onPress={onSave}
            disabled={saving}
          />
        </View>

        <Pressable
          accessibilityRole="button"
          onPress={() => setPwOpen(true)}
          testID="change-password-open"
          style={({ pressed }) => [
            styles.pwlink,
            pressed && { backgroundColor: colors.accentSoft },
          ]}
        >
          <Text style={styles.pwlinkText}>Change password</Text>
        </Pressable>

        {/* Quiet "Log out" row below "Change password" (Sept 2026) — same
            treatment, no confirmation. Web → login screen; native → the
            persisted session is cleared fully → role picker. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Log out"
          onPress={onLogout}
          testID="logout-row"
          style={({ pressed }) => [
            styles.pwlink,
            pressed && { backgroundColor: colors.accentSoft },
          ]}
        >
          <Text style={styles.pwlinkText}>
            {loggingOut ? 'Logging out…' : 'Log out'}
          </Text>
        </Pressable>
      </ScrollView>

      <ChangePasswordSheet
        visible={pwOpen}
        onClose={() => setPwOpen(false)}
        onSuccess={() => {
          setPwOpen(false);
          showToast('Password updated.');
        }}
      />

      {toastMsg ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMsg}</Text>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 40 },
  h1: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.28,
    marginTop: 6,
  },
  sub: { fontSize: 15, color: colors.body, lineHeight: 23, marginTop: 8 },
  cta: { marginTop: 24 },
  // Quiet "Change password" row below Save (approved spec §2.8, Sept 26).
  pwlink: {
    marginTop: 6,
    minHeight: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  pwlinkText: { fontSize: 15, fontWeight: '700', color: colors.accent },
  toast: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 28,
    backgroundColor: colors.ink,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 14.5,
    fontWeight: '600',
    textAlign: 'center',
  },
});
