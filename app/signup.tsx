// Clear to Close — realtor sign-up (approved onboarding/auth ⑰).
// Step 1 of 2. Full name + email + password (8+ chars to enable).
// Duplicate email → "Account already exists. Try logging in." + login path.
// Email confirmation required → form hides, check-inbox card only (with
// login / back-to-sign-up / resend actions). Network failure is retry-safe:
// no local state is written on failure.
import React, { useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { auth, type SignUpErrorCode } from '../src/lib/auth';
import { initCloudSync } from '../src/lib/store-instance';
import { BackChevron, Field, Kicker, PrimaryButton, useKeyboardHeight } from '../src/components/ui';
import { colors } from '../src/theme';

export default function SignUp() {
  const router = useRouter();
  // Keyboard avoidance (Sept 28, 2026, Anuraj: every input stays visible
  // above the keyboard). Shared pattern: bottom padding equal to the
  // keyboard height, so the focused field can scroll into view above it.
  const kbHeight = useKeyboardHeight();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<SignUpErrorCode | null>(null);
  const [busy, setBusy] = useState(false);
  // Resend-confirmation state (check-inbox card only). Errors render inline
  // inside the card; the card itself never leaves the screen for a resend.
  const [resendBusy, setResendBusy] = useState(false);
  const [resendError, setResendError] = useState<'rate_limited' | 'network' | 'unknown' | null>(null);

  const passwordShort = password.length > 0 && password.length < 8;
  const canSubmit =
    name.trim().length > 0 && email.trim().length > 0 && password.length >= 8 && !busy;

  const clearError = () => setError(null);

  // "Didn't get the email? Resend" — re-sends the signup confirmation to
  // the entered address. Rate limiting surfaces the existing rate_limited
  // copy inline; the inbox card stays put.
  const onResend = async () => {
    if (resendBusy) return;
    setResendBusy(true);
    setResendError(null);
    try {
      const r = await auth.resendConfirmation(email);
      if (!r.ok) {
        setResendError(r.code === 'rate_limited' ? 'rate_limited' : r.code === 'network' ? 'network' : 'unknown');
      }
      // Success → no error; the card stays as-is.
    } finally {
      setResendBusy(false);
    }
  };

  // "Back to sign up" — clears the card and restores the form. Name, email
  // and password live in ephemeral component state only (never persisted,
  // never logged) so they are intact; they drop on unmount.
  const onBackToSignUp = () => {
    setResendError(null);
    setError(null);
  };

  const onSubmit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await auth.signUp(name, email, password);
      if (!res.ok) {
        setError(res.code);
        return;
      }
      // Account exists → sync activates under the new identity, then step 2.
      await auth.setRole('realtor');
      await auth.setHasAccount(true);
      await auth.setPendingProfileName(name.trim());
      // Fallback sign-in on an existing account: arm the one-time
      // "we've signed you in" notice for profile-create.
      if (res.existingAccount) await auth.setExistingAccountNotice();
      try {
        await initCloudSync();
      } catch {
        // Sync is best-effort at this point; the deal list retries on boot.
      }
      router.replace('/profile-create');
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
        {error === 'email_confirmation_required' ? (
          // Check-inbox state: the form (and its Create account button)
          // hides entirely — re-taps would burn the 2/hour resend budget.
          // Only the card shows, with login / back / resend actions.
          <View style={styles.errorCard} testID="check-inbox-card">
            <Text style={styles.errorTitle}>Check your inbox</Text>
            <Text style={styles.errorSub}>
              Confirm your email, then log in to continue.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/login')}
              style={styles.errorLinkWrap}
            >
              <Text style={styles.errorLink}>Go to login →</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onBackToSignUp}
              style={styles.errorLinkWrap}
              testID="back-to-signup"
            >
              <Text style={styles.errorLinkSecondary}>Back to sign up</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onResend}
              disabled={resendBusy}
              style={styles.errorLinkWrap}
              testID="resend-confirmation"
            >
              <Text style={styles.errorLinkSecondary}>
                {resendBusy ? 'Sending…' : "Didn't get the email? Resend"}
              </Text>
            </Pressable>
            {resendError === 'rate_limited' ? (
              <Text style={styles.inlineError} testID="resend-rate-limited">
                Too many sign-up attempts. Please wait a few minutes and try again.
              </Text>
            ) : null}
            {resendError === 'network' ? (
              <Text style={styles.inlineError}>
                Couldn&apos;t reach the server. Check your connection and try again.
              </Text>
            ) : null}
            {resendError === 'unknown' ? (
              <Text style={styles.inlineError}>
                Something went wrong. Please try again.
              </Text>
            ) : null}
          </View>
        ) : (
          <>
            <BackChevron label="Role" onPress={() => router.push('/role')} />
            <Kicker>Step 1 of 2 · Realtor</Kicker>
            <Text style={styles.h1}>Create your account</Text>
            <Text style={styles.sub}>
              One account runs all your escrows. You stay signed in on this device until you log out.
            </Text>

            <View style={styles.form}>
              <Field
                label="Full name"
                value={name}
                onChangeText={(t) => { setName(t); clearError(); }}
                placeholder="e.g. Maya Chen"
                autoCapitalize="words"
              />
              <Field
                label="Email"
                value={email}
                onChangeText={(t) => { setEmail(t); clearError(); }}
                placeholder="you@brokerage.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Field
                label="Password"
                value={password}
                onChangeText={(t) => { setPassword(t); clearError(); }}
                placeholder="8+ characters"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              {passwordShort ? (
                <Text style={styles.inlineHint}>Use at least 8 characters.</Text>
              ) : null}
              {error === 'weak_password' ? (
                <Text style={styles.inlineError}>
                  That password doesn&apos;t meet the requirements. Try a longer one.
                </Text>
              ) : null}
            </View>

            <View style={styles.cta}>
              <PrimaryButton
                title={busy ? 'Creating account…' : 'Create account'}
                onPress={onSubmit}
                disabled={!canSubmit}
              />
            </View>

            {error === 'duplicate_email' ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorTitle}>Account already exists. Try logging in.</Text>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => router.push('/login')}
                  style={styles.errorLinkWrap}
                >
                  <Text style={styles.errorLink}>Log in instead →</Text>
                </Pressable>
              </View>
            ) : null}
            {error === 'network' ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorTitle}>Couldn&apos;t reach the server</Text>
                <Text style={styles.errorSub}>Check your connection and try again. Nothing was created.</Text>
              </View>
            ) : null}
            {error === 'unconfigured' ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorTitle}>Sign-up isn&apos;t available right now</Text>
                <Text style={styles.errorSub}>Please try again later.</Text>
              </View>
            ) : null}
            {error === 'rate_limited' ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorTitle}>Too many sign-up attempts</Text>
                <Text style={styles.errorSub}>
                  Please wait a few minutes and try again. No account was created.
                </Text>
              </View>
            ) : null}
            {error === 'unknown' ? (
              <View style={styles.errorCard}>
                <Text style={styles.errorTitle}>Something went wrong</Text>
                <Text style={styles.errorSub}>Please try again.</Text>
              </View>
            ) : null}

            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/login')}
              style={styles.loginRow}
            >
              <Text style={styles.loginText}>Already have an account? </Text>
              <Text style={styles.loginLink}>Log in</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
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
  form: { marginTop: 8 },
  inlineHint: { fontSize: 13, color: colors.muted, marginTop: 6 },
  inlineError: { fontSize: 13, fontWeight: '600', color: colors.red, marginTop: 6 },
  cta: { marginTop: 24 },
  errorCard: {
    marginTop: 16,
    backgroundColor: '#FBEFEA',
    borderWidth: 1,
    borderColor: '#EBC9BC',
    borderRadius: 14,
    padding: 14,
  },
  errorTitle: { fontSize: 15, fontWeight: '800', color: colors.ink },
  errorSub: { fontSize: 14, color: colors.body, lineHeight: 20, marginTop: 4 },
  errorLinkWrap: { marginTop: 8, alignSelf: 'flex-start' },
  errorLink: { fontSize: 15, fontWeight: '700', color: colors.accent },
  errorLinkSecondary: { fontSize: 15, fontWeight: '600', color: colors.body },
  loginRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 20,
    paddingVertical: 8,
  },
  loginText: { fontSize: 15, color: colors.body },
  loginLink: { fontSize: 15, fontWeight: '700', color: colors.accent },
});
