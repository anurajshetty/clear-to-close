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
import { Kicker, PrimaryButton, TextLink } from '../src/components/ui';
import { EMPTY_PROFILE_DRAFT, ProfileDraft, ProfileForm } from '../src/components/ProfileForm';
import { colors } from '../src/theme';

export default function ProfileCreate() {
  const router = useRouter();
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      auth
        .takePendingProfileName()
        .then((pending) => {
          if (pending && active) setDraft((d) => ({ ...d, name: pending }));
        })
        .catch(() => {});
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
    try {
      if (!skipped) {
        await store.saveProfile({
          name: draft.name.trim(),
          photoUri: draft.photoUri,
          about: draft.about,
          yearsExperience: draft.yearsExperience,
          dealsClosed: draft.dealsClosed,
          areasServed: draft.areasServed,
          phone: draft.phone,
          dreLicense: draft.dreLicense,
        });
      }
      await auth.setProfileSkipped(skipped);
      router.replace('/');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Kicker>Step 2 of 2 · Realtor</Kicker>
        <Text style={styles.h1}>Create your profile</Text>
        <Text style={styles.sub}>
          One profile, shown on every client&apos;s home view. You can edit it anytime later in your profile.
        </Text>

        <ProfileForm value={draft} onChange={patch} nameError={nameError} />

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
  cta: { marginTop: 24 },
});
