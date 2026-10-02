// Clear to Close — realtor profile creation (approved onboarding/auth ㉒).
// Step 2 of 2. No back chevron (the account already exists).
// Continue → deal list · Skip for now → deal list (+ "Complete your profile"
// nudge on the empty deal list). Profile stays editable via profile-update.
import React, { useCallback, useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { auth } from '../src/lib/auth';
import { store } from '../src/lib/store-instance';
import { Kicker, PrimaryButton, TextLink, useKeyboardHeight } from '../src/components/ui';
import { EMPTY_PROFILE_DRAFT, ProfileDraft, ProfileForm } from '../src/components/ProfileForm';
import { colors } from '../src/theme';

export default function ProfileCreate() {
  const router = useRouter();
  // Keyboard avoidance (Sept 28, 2026, Anuraj: every input stays visible
  // above the keyboard). Shared pattern: bottom padding equal to the
  // keyboard height, so the focused field can scroll into view above it.
  const kbHeight = useKeyboardHeight();
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Synchronous writes (Sept 28, 2026): saveProfile throws when the
  // profile is not confirmed on the server — the failure must be visible
  // on screen instead of silently landing the realtor on the deal list.
  const [saveError, setSaveError] = useState<string | null>(null);
  // One-time, non-blocking banner for the signup fallback path (existing
  // account + correct password). Armed by the signup screen via
  // setExistingAccountNotice; consumed here so it shows exactly once.
  const [showSignedInNotice, setShowSignedInNotice] = useState(false);

  const patch = useCallback(
    (p: Partial<ProfileDraft>) => {
      setDraft((d) => ({ ...d, ...p }));
      if (p.name !== undefined) setNameError(null);
    },
    [],
  );

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        const [existing, pending] = await Promise.all([
          store.getProfile().catch(() => null),
          auth.takePendingProfileName().catch(() => null),
        ]);
        const notice = await auth.takeExistingAccountNotice().catch(() => false);
        if (!active) return;
        // Name pre-fill: an existing profile's name wins. The just-typed
        // name was already consumed (discarded) by takePendingProfileName
        // above, so it can never silently overwrite the stored name on the
        // fallback path. New users have no profile — the typed name stands.
        const existingName = existing?.name?.trim();
        const prefill = existingName ? existing!.name : pending;
        if (prefill) setDraft((d) => ({ ...d, name: prefill }));
        if (notice) setShowSignedInNotice(true);
      })();
      return () => {
        active = false;
      };
    }, []),
  );

  const finish = async (skipped: boolean) => {
    if (busy) return;
    if (!skipped && !draft.name.trim()) {
      setNameError('Required');
      return;
    }
    setBusy(true);
    setSaveError(null);
    try {
      if (!skipped) {
        await store.saveProfile({
          name: draft.name.trim(),
          photoUri: draft.photoUri,
          photoRemoteUrl: null,
          bannerRemoteUrl: null,
        banner_image: draft.banner_image,
          about: draft.about,
          yearsExperience: draft.yearsExperience,
          email: draft.email,
          areasServed: draft.areasServed,
          phone: draft.phone,
          dreLicense: draft.dreLicense,
        realty_group: draft.realty_group,
          googleReviewLink: '',
          realtorComReviewLink: '',
          reviews: [],
          rating: null,
        });
      }
      await auth.setProfileSkipped(skipped);
      router.replace('/');
    } catch (err) {
      // The save threw: local state is unchanged — show the
      // plain-language reason so the realtor knows the profile did not land.
      setSaveError(
        err instanceof Error && err.message
          ? err.message
          : "Couldn't save your profile. Check your connection and try again.",
      );
      console.warn('saveProfile failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: kbHeight }]}
        keyboardShouldPersistTaps="handled"
      >
        <Kicker>Step 2 of 2 · Realtor</Kicker>
        <Text style={styles.h1}>Create your profile</Text>
        {showSignedInNotice ? (
          <View style={styles.noticeCard} testID="existing-account-notice">
            <Text style={styles.noticeText}>
              An account with this email already exists — we&apos;ve signed you in.
            </Text>
          </View>
        ) : null}
        <Text style={styles.sub}>
          One profile, shown on every client&apos;s home view. You can edit it anytime later in your profile.
        </Text>

        <ProfileForm value={draft} onChange={patch} nameError={nameError} />

        {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
        <View style={styles.cta}>
          <PrimaryButton
            title={busy ? 'Continuing…' : 'Continue'}
            onPress={() => finish(false)}
            disabled={busy}
          />
        </View>
        <TextLink title="Skip for now" onPress={() => finish(true)} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40 },
  h1: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.28,
    marginTop: 6,
  },
  sub: { fontSize: 15, color: colors.body, lineHeight: 23, marginTop: 8 },
  noticeCard: {
    backgroundColor: colors.card,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.line,
  },
  noticeText: { fontSize: 14, color: colors.body, lineHeight: 20 },
  cta: { marginTop: 24 },
  error: { fontSize: 13, color: colors.red, marginTop: 10 },
});
