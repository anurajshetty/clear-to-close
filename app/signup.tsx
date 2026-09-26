// Clear to Close — realtor sign-up (approved onboarding/auth ⑰).
// Step 1 of 2. Full name + email + password (8+ chars to enable).
// Duplicate email → "An account with this email already exists" + login path.
// Network failure is retry-safe: no local state is written on failure.
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
import { BackChevron, Field, Kicker, PrimaryButton } from '../src/components/ui';
import { colors } from '../src/theme';

export default function SignUp() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<SignUpErrorCode | null>(null);
  const [busy, setBusy] = useState(false);

  const isWeb = auth.isWeb();
  const passwordShort = password.length > 0 && password.length < 8;
  const canSubmit =
    name.trim().length > 0 && email.trim().length > 0 && password.length >= 8 && !busy;

  const clearError = () => setError(null);

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
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <BackChevron label="Role" onPress={() => router.push('/role')} />
        <Kicker>Step 1 of 2 · Realtor</Kicker>
        <Text style={styles.h1}>Create your account</Text>
        <Text style={styles.sub}>
          {isWeb
            ? "You'll sign in with email + password on every visit."
            : 'One account runs all your escrows. On this device, you stay signed in.'}
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
              That password doesn&apos;t meet the requirements — try a longer one.
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
            <Text style={styles.errorTitle}>An account with this email already exists</Text>
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
            <Text style={styles.errorSub}>Check your connection and try again — nothing was created.</Text>
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
              Please wait a few minutes and try again — no account was created.
            </Text>
          </View>
        ) : null}
        {error === 'email_confirmation_required' ? (
          <View style={styles.errorCard}>
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
