// Clear to Close: delete account confirmation (Nov 2026, approved
// mockup). Reached from the quiet "Delete account" row at the bottom
// of Profile. One screen: what deletion means, in the mockup's words,
// the password re-entered, and the permanent-delete button. The
// server does the work (delete-account Edge Function: identity from
// the session token only, password re-verified, sessions revoked,
// storage removed, data transaction, auth user deleted last).
//
// Outcomes handled here:
//   deleted: wipe the device like a log out, land on the welcome
//             screen with the one line "Your account has been
//             deleted."
//   husk: the data is gone but the sign-in survived; this screen
//             re-renders as the completion offer (Complete deletion
//             retries the same call, Log out leaves). The root
//             layout also routes a later husk sign-in here.
//   failure: inline error; nothing was deleted.
import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { auth, setExpectSignOut } from '../src/lib/auth';
import { store } from '../src/lib/store-instance';
import { BackChevron, Field, SecondaryButton, useKeyboardHeight } from '../src/components/ui';
import { colors } from '../src/theme';

const BULLETS: Array<[string, string]> = [
  [
    'Your profile is removed:',
    ' name, photo, banner, and public profile page.',
  ],
  [
    'Escrows you own are deleted:',
    ' checklists, intakes, team seats, client links, and activity. Your clients and team lose access right away.',
  ],
  [
    'Your seats on other realtors’ escrows are removed',
    ' and those seats free up for them to re-invite.',
  ],
  [
    'Your sign-in is deleted:',
    ' this email can sign up again later, but the old data does not come back.',
  ],
];

export default function DeleteAccount() {
  const router = useRouter();
  const kbHeight = useKeyboardHeight();
  const params = useLocalSearchParams<{ husk?: string }>();
  const [huskDone, setHuskDone] = useState(false);
  const huskView = params.husk === '1' || huskDone;
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The log out finish, shared by the deleted outcome and the husk
  // view's Log out: mark the sign-out deliberate, wipe the device,
  // clear the session, land on the welcome screen.
  const leaveToWelcome = async (withDeletedLine: boolean) => {
    setExpectSignOut(true);
    try {
      await store.clearLocalAccountData();
    } catch {
      // best-effort; sign-out proceeds regardless
    }
    try {
      await auth.signOut();
    } catch {
      // best-effort; navigation proceeds regardless
    }
    if (withDeletedLine) {
      router.replace({
        pathname: auth.isWeb() ? '/login' : '/role',
        params: { deleted: '1' },
      });
    } else {
      router.replace(auth.isWeb() ? '/login' : '/role');
    }
  };

  const onDelete = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const result = await auth.deleteAccount(password);
    if (result.ok && result.outcome === 'deleted') {
      await leaveToWelcome(true);
      return;
    }
    setBusy(false);
    if (result.ok) {
      // Husk: data gone, sign-in alive. Offer completion in place.
      setPassword('');
      setHuskDone(true);
      return;
    }
    if (result.code === 'wrong_password') {
      setError('That password is not correct. Nothing was deleted.');
    } else if (result.code === 'network') {
      setError('No connection. Nothing was deleted. Check your connection and try again.');
    } else {
      setError('Something went wrong. Nothing was deleted. Please try again.');
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 40 + kbHeight }]}
        keyboardShouldPersistTaps="handled"
      >
        {huskView ? null : (
          <BackChevron label="Profile" onPress={() => router.back()} />
        )}

        {huskView ? (
          <View>
            <Text style={styles.h1}>Your data is deleted</Text>
            <Text style={styles.sub}>
              Your profile, escrows, and files are gone. One step remains: your
              sign-in could not be removed. Enter your password and complete the
              deletion, or log out and finish it the next time you sign in.
            </Text>
          </View>
        ) : (
          <View>
            <Text style={styles.h1}>Delete your account?</Text>
            <Text style={styles.sub}>
              This permanently deletes your Clear to Close account. It cannot be
              undone.
            </Text>
            <View style={styles.bullets}>
              {BULLETS.map(([lead, rest]) => (
                <View key={lead} style={styles.bulletRow}>
                  <Text style={styles.bulletDot}>•</Text>
                  <Text style={styles.bulletText}>
                    <Text style={styles.bulletLead}>{lead}</Text>
                    {rest}
                  </Text>
                </View>
              ))}
            </View>
            <View style={styles.warnCard}>
              <Text style={styles.warnText}>
                If you only need a break,{' '}
                <Text style={styles.warnBold}>Log out</Text> instead. Nothing is
                deleted by logging out.
              </Text>
            </View>
          </View>
        )}

        <View style={styles.form}>
          <Field
            label="Enter your password to confirm"
            value={password}
            onChangeText={(t) => {
              setPassword(t);
              setError(null);
            }}
            placeholder="Password"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            error={error}
            testID="delete-password-field"
          />
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={huskView ? 'Complete deletion' : 'Delete my account permanently'}
          testID="delete-confirm-button"
          disabled={!password || busy}
          onPress={onDelete}
          style={({ pressed }) => [
            styles.deleteBtn,
            (!password || busy) && { opacity: 0.5 },
            pressed && !!password && !busy && { opacity: 0.88 },
          ]}
        >
          <Text style={styles.deleteBtnText}>
            {busy
              ? 'Deleting…'
              : huskView
                ? 'Complete deletion'
                : 'Delete my account permanently'}
          </Text>
        </Pressable>

        {huskView ? (
          <View style={styles.ghost}>
            <SecondaryButton title="Log out" onPress={() => void leaveToWelcome(false)} />
          </View>
        ) : (
          <View style={styles.ghost}>
            <SecondaryButton title="Cancel" onPress={() => router.back()} />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 20, paddingTop: 12 },
  h1: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.28,
    marginTop: 6,
  },
  sub: { fontSize: 15, color: colors.body, lineHeight: 23, marginTop: 8 },
  bullets: { marginTop: 18 },
  bulletRow: { flexDirection: 'row', marginTop: 10 },
  bulletDot: { fontSize: 15, color: colors.body, lineHeight: 22, marginRight: 8 },
  bulletText: { flex: 1, fontSize: 15, color: colors.body, lineHeight: 22 },
  bulletLead: { fontWeight: '700', color: colors.ink },
  warnCard: {
    marginTop: 18,
    backgroundColor: colors.amberSoft,
    borderWidth: 1,
    borderColor: '#EAD3A8',
    borderRadius: 14,
    padding: 14,
  },
  warnText: { fontSize: 14.5, color: colors.ink, lineHeight: 21 },
  warnBold: { fontWeight: '700' },
  form: { marginTop: 22 },
  deleteBtn: {
    marginTop: 22,
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: colors.red,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  deleteBtnText: { fontSize: 15.5, fontWeight: '700', color: '#FFFFFF' },
  ghost: { marginTop: 12 },
});
