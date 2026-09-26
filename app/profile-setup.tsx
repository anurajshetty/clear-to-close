// Clear to Close — realtor profile setup (one profile per realtor, shown to every client).
// Faithful to APPROVED mockup 01 · device 13. Uses the shared ProfileForm
// (also used by onboarding profile creation ㉒ and profile update ㉕).
import React, { useCallback, useState } from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { store } from '../src/lib/store-instance';
import { Kicker, PrimaryButton } from '../src/components/ui';
import { EMPTY_PROFILE_DRAFT, ProfileDraft, ProfileForm } from '../src/components/ProfileForm';
import { colors } from '../src/theme';

export default function ProfileSetup() {
  const router = useRouter();
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
  const [nameError, setNameError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

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
      store
        .getProfile()
        .then((p) => {
          if (!p || !active) return;
          setDraft({
            name: p.name ?? '',
            photoUri: p.photoUri ?? null,
            about: p.about ?? '',
            yearsExperience: p.yearsExperience ?? '',
            dealsClosed: p.dealsClosed ?? '',
            areasServed: p.areasServed ?? '',
            phone: p.phone ?? '',
            dreLicense: p.dreLicense ?? '',
          });
          setNameError(null);
        })
        .catch(() => {});
      return () => {
        active = false;
      };
    }, []),
  );

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
        about: draft.about,
        yearsExperience: draft.yearsExperience,
        dealsClosed: draft.dealsClosed,
        areasServed: draft.areasServed,
        phone: draft.phone,
        dreLicense: draft.dreLicense,
      });
      router.back();
    } catch {
      setSaving(false);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Kicker>Realtor profile</Kicker>
      <Text style={styles.h2}>Your profile</Text>
      <Text style={styles.desc}>
        One profile, shown on every client&apos;s home view. Keep it professional
        and brief.
      </Text>

      <ProfileForm value={draft} onChange={patch} nameError={nameError} />

      <View style={styles.saveWrap}>
        <PrimaryButton title={saving ? 'Saving…' : 'Save profile'} onPress={onSave} disabled={saving} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
  },
  h2: {
    fontSize: 26,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.26,
    marginTop: 6,
  },
  desc: {
    fontSize: 14,
    color: colors.body,
    lineHeight: 21.7,
    marginTop: 8,
  },
  saveWrap: {
    marginTop: 20,
  },
});
