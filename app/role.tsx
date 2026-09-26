// Clear to Close — first-launch role picker (approved onboarding/auth ⑯).
// "How are you joining?" Realtor → sign-up · Client → redeem.
// Shown once: the choice is remembered; mid-onboarding relaunches resume
// further down the funnel via the boot router.
import React, { useState } from 'react';
import {
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { useRouter } from 'expo-router';
import { auth } from '../src/lib/auth';
import { Kicker, PrimaryButton } from '../src/components/ui';
import { colors, radius } from '../src/theme';

function HouseIcon() {
  return (
    <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Path
        d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"
        stroke="#175E54"
        strokeWidth={1.8}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function KeyIcon() {
  return (
    <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" aria-hidden>
      <Circle cx={8} cy={8} r={4.2} stroke="#175E54" strokeWidth={1.8} />
      <Path d="M11 11l8 8m-3-3l2.5 2.5M14.5 14.5L17 17" stroke="#175E54" strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

type Choice = 'realtor' | 'client' | null;

export default function RolePicker() {
  const router = useRouter();
  const [choice, setChoice] = useState<Choice>(null);
  const [busy, setBusy] = useState(false);

  const onContinue = async () => {
    if (!choice || busy) return;
    setBusy(true);
    try {
      await auth.setRole(choice);
      router.push(choice === 'realtor' ? '/signup' : '/redeem');
    } finally {
      setBusy(false);
    }
  };

  const card = (key: 'realtor' | 'client', title: string, sub: string, icon: React.ReactNode) => {
    const selected = choice === key;
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ checked: selected }}
        accessibilityLabel={title}
        onPress={() => setChoice(key)}
        style={[styles.card, selected && styles.cardSelected]}
      >
        <View style={[styles.iconCircle, selected && styles.iconCircleSelected]}>{icon}</View>
        <View style={styles.cardText}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardSub}>{sub}</Text>
        </View>
        <View style={[styles.radio, selected && styles.radioSelected]}>
          {selected ? <View style={styles.radioDot} /> : null}
        </View>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Kicker>Clear to Close</Kicker>
        <Text style={styles.h1}>How are you joining?</Text>
        <Text style={styles.sub}>
          Pick the path that fits. You only see this once. The app remembers.
        </Text>

        <View style={styles.cards}>
          {card(
            'realtor',
            "I'm a Realtor",
            'Open escrows and track every deal from one place. Sign up or log in.',
            <HouseIcon />,
          )}
          {card('client', "I'm a client", 'I have an invite code', <KeyIcon />)}
        </View>

        <View style={styles.cta}>
          <PrimaryButton
            title={busy ? 'Continuing…' : 'Continue'}
            onPress={onContinue}
            disabled={!choice || busy}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 20, paddingTop: 28, paddingBottom: 40 },
  h1: {
    fontSize: 28,
    fontWeight: '800',
    color: colors.ink,
    letterSpacing: -0.28,
    marginTop: 6,
  },
  sub: { fontSize: 15, color: colors.body, lineHeight: 23, marginTop: 8 },
  cards: { marginTop: 24, gap: 14 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: 1.5,
    borderColor: colors.line,
    padding: 16,
  },
  cardSelected: { borderColor: colors.accent, backgroundColor: '#FFFFFF' },
  iconCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircleSelected: { backgroundColor: colors.accentSoft },
  cardText: { flex: 1, marginLeft: 14, marginRight: 10 },
  cardTitle: { fontSize: 17, fontWeight: '800', color: colors.ink },
  cardSub: { fontSize: 14, color: colors.body, lineHeight: 20, marginTop: 4 },
  radio: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: colors.muted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioSelected: { borderColor: colors.accent },
  radioDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: colors.accent },
  cta: { marginTop: 28 },
});
