// Clear to Close — "Change password" sheet (approved design §2.8, Sept 26).
// Opens from the quiet "Change password" row on the realtor profile page.
// Dismissal is exactly two paths: drag the sheet down via the grabber, or
// tap outside the sheet (scrim). No × — removed per Anuraj, Sept 26.
// Reopening starts with cleared fields. Success closes the sheet; the parent
// shows the "Password updated." toast.
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { PrimaryButton, Sheet } from './ui';
import {
  auth,
  validatePasswordChange,
  type ChangePasswordErrorCode,
} from '../lib/auth';
import { colors, radius } from '../theme';

/** Stroked eye from the approved mockup; slashed when the password is shown. */
function EyeIcon({ shown }: { shown: boolean }) {
  const c = colors.muted;
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden={true}>
      <Path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
        stroke={c}
        strokeWidth={1.8}
      />
      {shown ? (
        <Path
          d="M4 4l16 16"
          stroke={c}
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      ) : (
        <Circle cx={12} cy={12} r={3} stroke={c} strokeWidth={1.8} />
      )}
    </Svg>
  );
}

function PasswordField({
  label,
  value,
  onChangeText,
  placeholder,
  autoComplete,
  testID,
  shown,
  onToggleShow,
}: {
  label: string;
  value: string;
  onChangeText: (t: string) => void;
  placeholder: string;
  autoComplete: 'current-password' | 'new-password';
  testID: string;
  shown: boolean;
  onToggleShow: () => void;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.pwrap}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          secureTextEntry={!shown}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect={false}
          testID={testID}
          accessibilityLabel={label}
          style={styles.input}
        />
        <Pressable
          onPress={onToggleShow}
          accessibilityRole="button"
          accessibilityLabel={shown ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          accessibilityState={{ selected: shown }}
          testID={`${testID}-eye`}
          style={({ pressed }) => [
            styles.eyeBtn,
            pressed && { backgroundColor: colors.accentSoft },
          ]}
        >
          <EyeIcon shown={shown} />
        </Pressable>
      </View>
    </View>
  );
}

function serverErrorCopy(code: ChangePasswordErrorCode): string {
  switch (code) {
    case 'wrong_current':
      return 'Current password is incorrect — try again.';
    case 'weak_password':
      return 'Password needs 8+ characters.';
    case 'network':
      return "Couldn't reach the server — check your connection and try again.";
    case 'unconfigured':
      return 'Sign-in is not configured on this device yet.';
    default:
      return 'Something went wrong — try again.';
  }
}

export function ChangePasswordSheet({
  visible,
  onClose,
  onSuccess,
}: {
  visible: boolean;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [serverError, setServerError] =
    useState<ChangePasswordErrorCode | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Cleared fields every time the sheet opens.
  useEffect(() => {
    if (visible) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setShowCurrent(false);
      setShowNext(false);
      setShowConfirm(false);
      setServerError(null);
      setSubmitting(false);
    }
  }, [visible]);

  const v = validatePasswordChange(current, next, confirm);

  // Inline errors, revalidated on every keystroke: a server error clears as
  // soon as the user edits; client-side errors show live while typing.
  const inlineError: string | null =
    serverError === 'wrong_current'
      ? serverErrorCopy(serverError)
      : next.length > 0 && !v.newLongEnough
        ? 'Password needs 8+ characters.'
        : confirm.length > 0 && !v.confirmMatches
          ? "Passwords don't match."
          : serverError
            ? serverErrorCopy(serverError)
            : null;

  const clearServerError = () => {
    if (serverError) setServerError(null);
  };

  const submit = async () => {
    if (!v.canSubmit || submitting) return;
    setSubmitting(true);
    setServerError(null);
    const res = await auth.changePassword(current, next);
    setSubmitting(false);
    if (res.ok) {
      onSuccess();
    } else {
      setServerError(res.code);
    }
  };

  return (
    <Sheet visible={visible} onClose={onClose} dragToDismiss>
      <Text style={styles.title}>Change password</Text>
      <Text style={styles.hint}>
        Use 8 or more characters — same rule as when you signed up.
      </Text>

      <PasswordField
        label="Current password"
        value={current}
        onChangeText={(t) => {
          setCurrent(t);
          clearServerError();
        }}
        placeholder="Your current password"
        autoComplete="current-password"
        testID="pw-current"
        shown={showCurrent}
        onToggleShow={() => setShowCurrent((s) => !s)}
      />
      <PasswordField
        label="New password"
        value={next}
        onChangeText={(t) => {
          setNext(t);
          clearServerError();
        }}
        placeholder="8+ characters"
        autoComplete="new-password"
        testID="pw-new"
        shown={showNext}
        onToggleShow={() => setShowNext((s) => !s)}
      />
      <PasswordField
        label="Confirm new password"
        value={confirm}
        onChangeText={(t) => {
          setConfirm(t);
          clearServerError();
        }}
        placeholder="Re-type your new password"
        autoComplete="new-password"
        testID="pw-confirm"
        shown={showConfirm}
        onToggleShow={() => setShowConfirm((s) => !s)}
      />

      {inlineError ? (
        <Text style={styles.errline} testID="pw-error">
          {inlineError}
        </Text>
      ) : null}

      <View style={styles.cta}>
        <PrimaryButton
          title={submitting ? 'Updating…' : 'Update password'}
          onPress={submit}
          disabled={!v.canSubmit || submitting}
        />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.22,
  },
  hint: { fontSize: 14.5, color: colors.body, lineHeight: 22, marginTop: 6 },
  fieldWrap: { marginTop: 16 },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.body,
    marginBottom: 8,
  },
  pwrap: { position: 'relative', justifyContent: 'center' },
  input: {
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: radius.input,
    paddingVertical: 13,
    paddingHorizontal: 14,
    paddingRight: 54,
    fontSize: 16,
    color: colors.ink,
    backgroundColor: colors.inputBg,
  },
  eyeBtn: {
    position: 'absolute',
    right: 4,
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errline: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.red,
    marginTop: 12,
  },
  cta: { marginTop: 18 },
});
