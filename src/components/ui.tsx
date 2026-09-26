// Clear to Close — shared UI primitives (Kicker, Card, buttons, Field, Sheet, Grip)
// Faithful to APPROVED mockup 01 · Escrow tracker v1. react-native + react-native-web compatible.
import React, { ReactNode } from 'react';
import {
  Modal, Pressable, StyleSheet, Text, TextInput, View, ViewStyle, TextStyle,
} from 'react-native';
import { colors, radius } from '../theme';

export function Kicker({ children }: { children: ReactNode }) {
  return <Text style={styles.kicker}>{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function PrimaryButton({
  title, onPress, disabled,
}: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btnPrimary,
        disabled && styles.btnDisabled,
        pressed && !disabled && { opacity: 0.88 },
      ]}
    >
      <Text style={styles.btnPrimaryText}>{title}</Text>
    </Pressable>
  );
}

export function SecondaryButton({
  title, onPress, disabled,
}: { title: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.btnSecondary,
        disabled && { opacity: 0.5 },
        pressed && !disabled && { backgroundColor: colors.accentSoft },
      ]}
    >
      <Text style={styles.btnSecondaryText}>{title}</Text>
    </Pressable>
  );
}

/** Text-only link used for secondary navigation (e.g. "Skip for now"). */
export function TextLink({ title, onPress }: { title: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.textLinkWrap, pressed && { opacity: 0.7 }]}
    >
      <Text style={styles.textLink}>{title}</Text>
    </Pressable>
  );
}

/** Back chevron row ("‹ Label") used by onboarding screens. */
export function BackChevron({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Back to ${label}`}
      onPress={onPress}
      style={({ pressed }) => [styles.backChevron, pressed && { opacity: 0.7 }]}
    >
      <Text style={styles.backChevronGlyph}>‹</Text>
      <Text style={styles.backChevronLabel}>{label}</Text>
    </Pressable>
  );
}

export function Field({
  label, value, onChangeText, placeholder, multiline,
  secureTextEntry, keyboardType, autoCapitalize, autoCorrect,
}: {
  label: string; value: string; onChangeText: (t: string) => void;
  placeholder?: string; multiline?: boolean;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'numeric';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        multiline={!!multiline}
        secureTextEntry={!!secureTextEntry}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        autoCorrect={autoCorrect ?? true}
        style={[styles.fieldInput, multiline && styles.fieldInputMultiline]}
      />
    </View>
  );
}

export function Sheet({
  visible, onClose, children,
}: { visible: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.sheetOverlay} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss sheet" />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        {children}
      </View>
    </Modal>
  );
}

// Six-dot drag grip (2 columns x 3 rows), 10x18
export function Grip() {
  return (
    <View style={styles.grip} pointerEvents="none">
      {Array.from({ length: 6 }).map((_, i) => (
        <View key={i} style={styles.gripDot} />
      ))}
    </View>
  );
}

// "Maya Chen" -> "MC" — used for the realtor photo-circle fallbacks.
export function initialsOf(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

const styles = StyleSheet.create({
  kicker: {
    fontSize: 12, letterSpacing: 1.7, textTransform: 'uppercase',
    color: colors.accent, fontWeight: '700',
  } as TextStyle,
  card: {
    backgroundColor: colors.card, borderRadius: radius.card, padding: 16,
    borderWidth: 1, borderColor: 'rgba(231,224,211,0.7)',
    shadowColor: '#1E1910', shadowOpacity: 0.06, shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 }, elevation: 2,
  },
  btnPrimary: {
    alignItems: 'center', justifyContent: 'center', width: '100%',
    minHeight: 52, backgroundColor: colors.accent, borderRadius: radius.button,
  },
  btnPrimaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
  btnDisabled: { backgroundColor: '#D5CCB9' },
  btnSecondary: {
    alignItems: 'center', justifyContent: 'center', width: '100%',
    minHeight: 52, backgroundColor: '#FFFFFF', borderWidth: 1.5,
    borderColor: colors.accent, borderRadius: radius.button,
  },
  btnSecondaryText: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  fieldWrap: { marginTop: 16 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: colors.body, marginBottom: 8 },
  fieldInput: {
    borderWidth: 1.5, borderColor: colors.line, borderRadius: radius.input,
    paddingVertical: 13, paddingHorizontal: 14, fontSize: 15,
    color: colors.ink, backgroundColor: colors.inputBg,
  } as TextStyle,
  fieldInputMultiline: { minHeight: 96, textAlignVertical: 'top', lineHeight: 22 },
  sheetOverlay: {
    flex: 1, backgroundColor: 'rgba(33,29,23,0.45)',
  },
  sheet: {
    backgroundColor: colors.card, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 14, paddingBottom: 26,
  },
  grabber: {
    width: 40, height: 5, borderRadius: 99, backgroundColor: colors.line,
    alignSelf: 'center', marginBottom: 16,
  },
  grip: {
    flexDirection: 'row', flexWrap: 'wrap', width: 10, height: 18,
    alignContent: 'center', justifyContent: 'space-between',
  },
  gripDot: {
    width: 4, height: 4, borderRadius: 2, backgroundColor: colors.gripDot, marginBottom: 3,
  },
  textLinkWrap: { alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 8 },
  textLink: { fontSize: 15, fontWeight: '700', color: colors.accent },
  backChevron: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingVertical: 8, paddingRight: 12 },
  backChevronGlyph: { fontSize: 26, fontWeight: '400', color: colors.accent, marginTop: -3 },
  backChevronLabel: { fontSize: 15, fontWeight: '600', color: colors.accent, marginLeft: 2 },
});
