// Clear to Close — "Set new password" recovery screen (WEB ONLY).
//
// Landed on from a password-reset email link, which opens in the browser by
// design (the user sets the new password there, then signs into the iPhone
// app with it). The root layout parses the recovery payload from the URL
// fragment on app start, establishes the recovery session, and routes here;
// expired/invalid links arrive with ?expired=1 and get a fresh-link path.
//
// Design mirrors the approved "Change password" sheet (src/components/
// ChangePasswordSheet.tsx): same field component with eye toggles, same
// inline error styles, same 8+ rule. No current-password field — the
// recovery link IS the authentication.
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
import {
  auth,
  validatePasswordReset,
  type RecoverySetPasswordErrorCode,
} from '../src/lib/auth';
import { PasswordField } from '../src/components/ChangePasswordSheet';
import { Field, Kicker, PrimaryButton, useKeyboardHeight } from '../src/components/ui';
import { colors } from '../src/theme';

const RESET_CONFIRMATION =
  'If an account exists for this email, a reset link is on its way.';

function recoveryErrorCopy(code: RecoverySetPasswordErrorCode): string {
  switch (code) {
    case 'weak_password':
      return 'Password needs 8+ characters.';
    case 'network':
      return "Couldn't reach the server. Check your connection and try again.";
    case 'unconfigured':
      return 'Sign-in is not configured on this device yet.';
    case 'session_expired':
      return 'This link has expired.';
    default:
      return 'Something went wrong. Try again.';
  }
}

export default function ResetPassword() {
  const router = useRouter();
  // Keyboard avoidance (Sept 28, 2026, Anuraj: every input stays visible
  // above the keyboard). Shared pattern: bottom padding equal to the
  // keyboard height, so the focused field can scroll into view above it.
  const kbHeight = useKeyboardHeight();
  const params = useLocalSearchParams<{ expired?: string }>();
  const [linkDead, setLinkDead] = useState(params.expired === '1');

  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [serverError, setServerError] =
    useState<RecoverySetPasswordErrorCode | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [email, setEmail] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [resetNetworkError, setResetNetworkError] = useState(false);
  const [sending, setSending] = useState(false);

  const v = validatePasswordReset(next, confirm);

  // Same live inline errors as the change-password sheet.
  const inlineError: string | null =
    serverError && serverError !== 'session_expired'
      ? recoveryErrorCopy(serverError)
      : next.length > 0 && !v.newLongEnough
        ? 'Password needs 8+ characters.'
        : confirm.length > 0 && !v.confirmMatches
          ? "Passwords don't match."
          : null;

  const submit = async () => {
    if (!v.canSubmit || submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await auth.setPasswordFromRecovery(next);
      if (res.ok) {
        // Recovery session is now a live realtor session: boot routing
        // sends a signed-in realtor to the deal list.
        await auth.setRole('realtor');
        await auth.setHasAccount(true);
        router.replace('/' as never);
        return;
      }
      if (res.code === 'session_expired') {
        setLinkDead(true);
      } else {
        setServerError(res.code);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const resend = async () => {
    if (!email.trim() || sending) return;
    setSending(true);
    setResetNetworkError(false);
    try {
      const res = await auth.sendPasswordReset(email);
      if (!res.ok) {
        setResetNetworkError(true);
        return;
      }
      setResetSent(true);
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: kbHeight }]}
        keyboardShouldPersistTaps="handled"
      >
        {linkDead ? (
          <View>
            <Kicker>Reset password</Kicker>
            <Text style={styles.h1}>Link expired</Text>
            {resetSent ? (
              <Text style={styles.sub}>{RESET_CONFIRMATION}</Text>
            ) : (
              <>
                <Text style={styles.sub}>
                  This reset link has expired or was already used. Enter your
                  email and we will send you a fresh one.
                </Text>
                <View style={styles.form}>
                  <Field
                    label="Email"
                    value={email}
                    onChangeText={(t) => {
                      setEmail(t);
                      setResetNetworkError(false);
                    }}
                    placeholder="you@brokerage.com"
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    testID="rp-email"
                  />
                </View>
                <View style={styles.cta}>
                  <PrimaryButton
                    title={sending ? 'Sending…' : 'Send a new link'}
                    onPress={resend}
                    disabled={!email.trim() || sending}
                  />
                </View>
                {resetNetworkError ? (
                  <Text style={styles.inlineError}>
                    Couldn&apos;t reach the server. Check your connection and
                    try again.
                  </Text>
                ) : null}
              </>
            )}
            <Pressable
              accessibilityRole="button"
              onPress={() => router.replace('/login' as never)}
              style={styles.centerRow}
            >
              <Text style={styles.link}>Back to log in</Text>
            </Pressable>
          </View>
        ) : (
          <View>
            <Kicker>Reset password</Kicker>
            <Text style={styles.h1}>Set new password</Text>
            <Text style={styles.sub}>
              Use 8 or more characters. Same rule as when you signed up.
            </Text>
            <View style={styles.form}>
              <PasswordField
                label="New password"
                value={next}
                onChangeText={(t) => {
                  setNext(t);
                  setServerError(null);
                }}
                placeholder="8+ characters"
                autoComplete="new-password"
                testID="rp-new"
                shown={showNext}
                onToggleShow={() => setShowNext((s) => !s)}
              />
              <PasswordField
                label="Confirm new password"
                value={confirm}
                onChangeText={(t) => {
                  setConfirm(t);
                  setServerError(null);
                }}
                placeholder="Re-type your new password"
                autoComplete="new-password"
                testID="rp-confirm"
                shown={showConfirm}
                onToggleShow={() => setShowConfirm((s) => !s)}
              />
            </View>
            {inlineError ? (
              <Text style={styles.inlineError} testID="rp-error">
                {inlineError}
              </Text>
            ) : null}
            <View style={styles.cta}>
              <PrimaryButton
                title={submitting ? 'Setting…' : 'Set new password'}
                onPress={submit}
                disabled={!v.canSubmit || submitting}
              />
            </View>
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
  inlineError: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.red,
    marginTop: 8,
  },
  centerRow: { alignItems: 'center', marginTop: 16, paddingVertical: 8 },
  link: { fontSize: 15, fontWeight: '700', color: colors.accent },
});
