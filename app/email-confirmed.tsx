// Clear to Close — email confirmation landing (approved Oct 23, 2026).
//
// The signup confirmation link opens THIS page in the browser (see
// AUTH_CONFIRM_REDIRECT_URL in src/lib/auth.ts). It simply states the
// outcome as text on a card — confirmed, or expired/used/invalid —
// replacing the old silent landing on the login page for every
// outcome. Text only by design: no buttons, no links, no forms. Once
// confirmed, the person opens the app and logs in there.
//
// Presentation only: the page reads the fragment's outcome via
// parseConfirmationLink and never consumes the tokens; signup,
// login, and check-your-inbox flows are unchanged. A visit with no
// recognizable outcome (a bare or already-consumed link) shows the
// expired state, whose copy covers the already-confirmed case.
import React, { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { parseConfirmationLink } from '../src/lib/auth';
import { colors } from '../src/theme';

type LandingState = 'confirmed' | 'expired';

function initialState(): LandingState {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return parseConfirmationLink(window.location.href).kind === 'confirmed'
      ? 'confirmed'
      : 'expired';
  }
  return 'expired';
}

export default function EmailConfirmed() {
  const [state] = useState<LandingState>(initialState);

  useEffect(() => {
    // Token hygiene (mirrors the recovery flow): drop the fragment
    // once the outcome has been read, so the tokens don't linger in
    // the address bar or history.
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    try {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
    } catch {
      // ignore
    }
  }, []);

  const confirmed = state === 'confirmed';
  return (
    <View style={styles.page}>
      <View style={styles.frame}>
        <Text style={styles.brand}>CLEAR TO CLOSE</Text>
        <View style={styles.card}>
          <View
            style={[styles.icon, confirmed ? styles.iconOk : styles.iconWarn]}
            aria-hidden={true}
          >
            <Text style={[styles.iconGlyph, !confirmed && styles.iconGlyphWarn]}>
              {confirmed ? '✓' : '🕐'}
            </Text>
          </View>
          <Text style={styles.title} testID="confirmation-title">
            {confirmed ? 'Your account is confirmed' : 'This link has expired'}
          </Text>
          <Text style={styles.body} testID="confirmation-body">
            {confirmed
              ? 'Your email is verified. You can now open the Clear to Close app and log in.'
              : 'Please sign up again with the same email address to get a new confirmation link. If your account is already confirmed, just open the app and log in.'}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.paper,
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingTop: 26,
  },
  frame: {
    width: '100%',
    maxWidth: 360,
  },
  brand: {
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 2.2,
    color: colors.accent,
    marginBottom: 22,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 18,
    paddingTop: 26,
    paddingHorizontal: 20,
    paddingBottom: 22,
    alignItems: 'center',
  },
  icon: {
    width: 62,
    height: 62,
    borderRadius: 31,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  iconOk: { backgroundColor: colors.accentSoft },
  iconWarn: { backgroundColor: colors.amberSoft },
  iconGlyph: {
    fontSize: 28,
    color: colors.accent,
  },
  iconGlyphWarn: { color: colors.amber },
  title: {
    fontSize: 21,
    fontWeight: '800',
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 8,
  },
  body: {
    fontSize: 14,
    color: colors.body,
    lineHeight: 21.7,
    textAlign: 'center',
  },
});
