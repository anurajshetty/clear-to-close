// Clear to Close — realtor login + password reset (approved onboarding/auth ⑱).
// Email + password only. Wrong credentials → inline error, stays on login.
// Reset is anti-enumeration: the confirmation copy is identical whether or
// not the email is registered. expired=1 → the session-expiry banner.
import React, { useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { auth, type SignInErrorCode } from '../src/lib/auth';
import { initCloudSync, store } from '../src/lib/store-instance';
import { resolvePostAuthHref } from '../src/lib/bootRoute';
import { BackChevron, Field, Kicker, PrimaryButton } from '../src/components/ui';
import { colors } from '../src/theme';

const RESET_CONFIRMATION = 'If an account exists for this email, a reset link is on its way.';

export default function Login() {
  const router = useRouter();
  const params = useLocalSearchParams<{ expired?: string }>();
  const expired = params.expired === '1';

  const [mode, setMode] = useState<'login' | 'reset' | 'resetDone'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<SignInErrorCode | null>(null);
  const [resetNetworkError, setResetNetworkError] = useState(false);
  const [busy, setBusy] = useState(false);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !busy;
  const canSendReset = email.trim().length > 0 && !busy;

  const onLogin = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await auth.signIn(email, password);
      if (!res.ok) {
        setError(res.code);
        return;
      }
      await auth.setRole('realtor');
      await auth.setHasAccount(true);
      try {
        await initCloudSync();
      } catch {
        // Sync retries on boot.
      }
      // Mid-onboarding resume: a step-1-only account (no profile, never
      // skipped) lands on profile creation, not the deal list. The profile
      // is pulled from the cloud when the local store is missing it (login
      // on a new device), so an existing account never lands on profile
      // creation by mistake.
      const sessionUserId = await auth.getSessionUserId();
      let href = '/';
      try {
        const [profile, skipped] = await Promise.all([
          store.pullProfileFromCloud(),
          auth.getProfileSkipped(),
        ]);
        href = resolvePostAuthHref({ sessionUserId, profile, skipped });
      } catch {
        // Profile read failure: fall through to the deal list.
      }
      router.replace(href as never);
    } finally {
      setBusy(false);
    }
  };

  const onSendReset = async () => {
    if (!canSendReset) return;
    setBusy(true);
    setResetNetworkError(false);
    try {
      const res = await auth.sendPasswordReset(email);
      if (!res.ok) {
        // Network only — every other outcome shows the same confirmation.
        setResetNetworkError(true);
        return;
      }
      setMode('resetDone');
    } finally {
      setBusy(false);
    }
  };

  const goReset = () => {
    setMode('reset');
    setError(null);
    setResetNetworkError(false);
  };
  const goLogin = () => {
    setMode('login');
    setError(null);
    setResetNetworkError(false);
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <BackChevron label="Role" onPress={() => router.push('/role')} />

        {mode === 'resetDone' ? (
          <View>
            <Kicker>Reset password</Kicker>
            <Text style={styles.h1}>Check your email</Text>
            <Text style={styles.sub}>{RESET_CONFIRMATION}</Text>
            <Pressable accessibilityRole="button" onPress={goLogin} style={styles.centerRow}>
              <Text style={styles.link}>Back to log in</Text>
            </Pressable>
          </View>
        ) : mode === 'reset' ? (
          <View>
            <Kicker>Reset password</Kicker>
            <Text style={styles.h1}>Reset your password</Text>
            <Text style={styles.sub}>
              Enter your account email — we&apos;ll send a reset link.
            </Text>
            <View style={styles.form}>
              <Field
                label="Email"
                value={email}
                onChangeText={(t) => { setEmail(t); setResetNetworkError(false); }}
                placeholder="you@brokerage.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View style={styles.cta}>
              <PrimaryButton
                title={busy ? 'Sending…' : 'Send reset link'}
                onPress={onSendReset}
                disabled={!canSendReset}
              />
            </View>
            {resetNetworkError ? (
              <Text style={styles.inlineError}>
                Couldn&apos;t reach the server — check your connection and try again.
              </Text>
            ) : null}
            <Pressable accessibilityRole="button" onPress={goLogin} style={styles.centerRow}>
              <Text style={styles.link}>Back to log in</Text>
            </Pressable>
          </View>
        ) : (
          <View>
            <Kicker>Welcome back</Kicker>
            <Text style={styles.h1}>Log in</Text>
            <Text style={styles.sub}>Log in to pick up where you left off.</Text>
            {expired ? (
              <View style={styles.expiredCard}>
                <Text style={styles.expiredText}>Your session expired — log in again.</Text>
              </View>
            ) : null}
            <View style={styles.form}>
              <Field
                label="Email"
                value={email}
                onChangeText={(t) => { setEmail(t); setError(null); }}
                placeholder="you@brokerage.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Field
                label="Password"
                value={password}
                onChangeText={(t) => { setPassword(t); setError(null); }}
                placeholder="Your password"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              {error === 'invalid_credentials' ? (
                <Text style={styles.inlineError}>Wrong email or password — try again.</Text>
              ) : null}
              {error === 'network' ? (
                <Text style={styles.inlineError}>
                  Couldn&apos;t reach the server — check your connection and try again.
                </Text>
              ) : null}
              {error === 'unconfigured' || error === 'unknown' ? (
                <Text style={styles.inlineError}>Something went wrong — please try again.</Text>
              ) : null}
            </View>
            <View style={styles.cta}>
              <PrimaryButton
                title={busy ? 'Logging in…' : 'Log in'}
                onPress={onLogin}
                disabled={!canSubmit}
              />
            </View>
            <Pressable accessibilityRole="button" onPress={goReset} style={styles.centerRow}>
              <Text style={styles.link}>Forgot password?</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/signup')}
              style={styles.signupRow}
            >
              <Text style={styles.signupText}>New here? </Text>
              <Text style={styles.link}>Create an account</Text>
            </Pressable>
          </View>
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
  cta: { marginTop: 24 },
  inlineError: { fontSize: 13, fontWeight: '600', color: colors.red, marginTop: 8 },
  expiredCard: {
    marginTop: 14,
    backgroundColor: colors.amberSoft,
    borderWidth: 1,
    borderColor: '#EAD3A8',
    borderRadius: 14,
    padding: 14,
  },
  expiredText: { fontSize: 15, fontWeight: '700', color: colors.ink },
  centerRow: { alignItems: 'center', marginTop: 16, paddingVertical: 8 },
  link: { fontSize: 15, fontWeight: '700', color: colors.accent },
  signupRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
    paddingVertical: 8,
  },
  signupText: { fontSize: 15, color: colors.body },
});
