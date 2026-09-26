// Clear to Close — realtor profile update (approved onboarding/auth ㉕ + ㉑).
// Opens from the deal-list header avatar. Same shared ProfileForm, Save
// returns to the deal list. Log out is native-only (㉑): web shows no
// logout affordance. Logout clears the session fully → role picker.
import React, { useCallback, useRef, useState } from 'react';
import {
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
import { BackChevron, Kicker, PrimaryButton } from '../src/components/ui';
import { ChangePasswordSheet } from '../src/components/ChangePasswordSheet';
import { EMPTY_PROFILE_DRAFT, ProfileDraft, ProfileForm } from '../src/components/ProfileForm';
import { colors } from '../src/theme';

export default function ProfileUpdate() {
  const router = useRouter();
  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE_DRAFT);
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
      // A completed profile clears the onboarding "complete your profile" nudge.
      await auth.setProfileSkipped(false);
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
      await auth.signOut();
    } finally {
      router.replace('/role');
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
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

        {auth.isWeb() ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={onLogout}
            style={styles.logoutRow}
          >
            <Text style={styles.logoutText}>
              {loggingOut ? 'Logging out…' : 'Log out'}
            </Text>
          </Pressable>
        )}
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
  logoutRow: {
    marginTop: 28,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    alignItems: 'center',
  },
  logoutText: { fontSize: 16, fontWeight: '700', color: colors.red },
});
