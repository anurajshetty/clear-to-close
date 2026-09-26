// Clear to Close — client join screen (name + invite code redeem).
// Faithful to APPROVED mockup 01 · Escrow tracker v1, device ⑩.
import React, { useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { store } from '../src/lib/store-instance';
import type { RedeemResult } from '../src/lib/types';
import { Field, Kicker, PrimaryButton } from '../src/components/ui';
import { colors, radius } from '../src/theme';

type Who = 'realtor' | 'client';
type RedeemError = 'invalid' | 'name_mismatch' | 'revoked' | 'already_used';

function errorCopy(err: RedeemError): { main: string; sub?: string } {
  switch (err) {
    case 'revoked':
      return {
        main: 'This invite was revoked — ask your realtor for a fresh one.',
      };
    case 'already_used':
      return {
        main: 'This code was already used — ask your realtor for a fresh one.',
      };
    default:
      return {
        main: "That code didn't work — check it and try again.",
        sub: 'Check the name and code — or ask your realtor for a fresh one.',
      };
  }
}

export default function Redeem() {
  const router = useRouter();
  const [who, setWho] = useState<Who>('client');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<RedeemError | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2600);
  };

  const ready = name.trim().length > 0 && code.length === 6;

  const verify = async () => {
    if (verifying || !ready) return;
    setVerifying(true);
    setError(null);
    try {
      const res: RedeemResult = await store.redeemInvite(code, name.trim());
      if (res.ok) {
        showToast("You're connected.");
        const target =
          res.role === 'buyer'
            ? `/client/buyer/${res.escrowId}`
            : `/client/seller/${res.escrowId}`;
        setTimeout(() => {
          router.replace(target);
        }, 900);
      } else {
        setError(res.error);
      }
    } catch (err) {
      console.warn('redeemInvite failed', err);
      setError('invalid');
    } finally {
      setVerifying(false);
    }
  };

  const errCopy = error ? errorCopy(error) : null;

  return (
    <View style={styles.screen}>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.head}>
          <Kicker>Clear to Close</Kicker>
          <Text style={styles.h2}>Join your escrow</Text>
          <Text style={styles.sub}>
            Your realtor invited you to follow along. No account, no password — just
            the name and code from your invite.
          </Text>
        </View>

        <Text style={styles.fieldLabel}>Who’s joining?</Text>
        <View style={styles.roleRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: who === 'realtor' }}
            onPress={() => setWho('realtor')}
            style={[
              styles.pick,
              who === 'realtor' && styles.pickSelected,
            ]}
          >
            <Text
              style={[
                styles.pickTitle,
                who === 'realtor' && styles.pickTitleSelected,
              ]}
            >
              I’m a realtor
            </Text>
            <Text style={styles.pickSub}>My escrows</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: who === 'client' }}
            onPress={() => setWho('client')}
            style={[styles.pick, who === 'client' && styles.pickSelected]}
          >
            <Text
              style={[
                styles.pickTitle,
                who === 'client' && styles.pickTitleSelected,
              ]}
            >
              I’m a client
            </Text>
            <Text style={styles.pickSub}>Join with a code</Text>
          </Pressable>
        </View>

        {who === 'realtor' ? (
          <View>
            <Text style={styles.realtorNote}>
              The realtor app opens your escrow list. If you’re here with an
              invite code, choose “I’m a client”.
            </Text>
            <PrimaryButton title="Open my escrows" onPress={() => router.replace('/')} />
          </View>
        ) : (
          <View>
            <Field
              label="Your name"
              value={name}
              onChangeText={(v) => {
                setName(v);
                setError(null);
              }}
              placeholder="e.g. Priya Nair"
            />
            <Text style={styles.hint}>
              Use the <Text style={styles.hintBold}>same name</Text> your realtor
              entered when creating this invite — it has to match exactly.
            </Text>

            <Text style={styles.fieldLabel}>Invite code</Text>
            <TextInput
              value={code}
              onChangeText={(v) => {
                setCode(
                  v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6),
                );
                setError(null);
              }}
              placeholder="••••••"
              placeholderTextColor={colors.muted}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={6}
              style={[styles.codeInput, error && styles.codeInputError]}
            />

            {errCopy && (
              <View style={styles.errWrap}>
                <Text style={styles.errMain}>{errCopy.main}</Text>
                {errCopy.sub && (
                  <Text style={styles.errSub}>{errCopy.sub}</Text>
                )}
              </View>
            )}

            <View style={styles.verifyWrap}>
              <PrimaryButton
                title={verifying ? 'Checking…' : 'Verify'}
                onPress={verify}
                disabled={!ready || verifying}
              />
            </View>
          </View>
        )}
      </ScrollView>

      {toastMsg && (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMsg}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.paper,
  },
  list: {
    flex: 1,
  },
  content: {
    padding: 18,
    paddingTop: 20,
    paddingBottom: 40,
  },
  head: {
    marginBottom: 20,
  },
  h2: {
    fontSize: 26,
    fontWeight: '700',
    color: colors.ink,
    letterSpacing: -0.26,
    marginTop: 8,
  },
  sub: {
    fontSize: 14.5,
    lineHeight: 22.5,
    color: colors.body,
    marginTop: 6,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.body,
    marginTop: 20,
    marginBottom: 8,
  },
  roleRow: {
    flexDirection: 'row',
    gap: 10,
  },
  pick: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: 14,
    backgroundColor: colors.card,
    paddingVertical: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
  },
  pickSelected: {
    borderColor: colors.accent,
    backgroundColor: colors.accentSoft,
  },
  pickTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.body,
  },
  pickTitleSelected: {
    color: colors.ink,
  },
  pickSub: {
    fontSize: 12.5,
    color: colors.muted,
    marginTop: 4,
  },
  realtorNote: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.body,
    marginBottom: 16,
  },
  hint: {
    fontSize: 13,
    lineHeight: 19,
    color: colors.muted,
    marginTop: 8,
  },
  hintBold: {
    fontWeight: '700',
    color: colors.body,
  },
  codeInput: {
    borderWidth: 1.5,
    borderColor: colors.line,
    borderRadius: radius.input,
    paddingVertical: 13,
    paddingHorizontal: 14,
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 4,
    color: colors.ink,
    backgroundColor: colors.inputBg,
  },
  codeInputError: {
    borderColor: colors.red,
  },
  errWrap: {
    marginTop: 10,
  },
  errMain: {
    fontSize: 13.5,
    lineHeight: 20,
    color: colors.red,
  },
  errSub: {
    fontSize: 12.5,
    lineHeight: 19,
    color: colors.muted,
    marginTop: 2,
  },
  verifyWrap: {
    marginTop: 16,
  },
  toast: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 40,
    backgroundColor: colors.ink,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toastText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
});
