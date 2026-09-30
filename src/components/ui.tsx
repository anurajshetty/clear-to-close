// Clear to Close — shared UI primitives (Kicker, Card, buttons, Field, Sheet, Grip)
// Faithful to APPROVED mockup 01 · Escrow tracker v1. react-native + react-native-web compatible.
import React, { ReactNode, useEffect, useRef, useState } from 'react';
import {
  Animated, Keyboard, Modal, PanResponder, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, ViewStyle, TextStyle,
  useWindowDimensions,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors, radius } from '../theme';

export function Kicker({ children }: { children: ReactNode }) {
  return <Text style={styles.kicker}>{children}</Text>;
}

export function Card({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: ViewStyle;
  testID?: string;
}) {
  return (
    <View style={[styles.card, style]} testID={testID}>
      {children}
    </View>
  );
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

/**
 * Confirmation popup dialog (Sept 2026): a centered modal that appears right
 * at the point of action so the confirm action is seen immediately — used
 * instead of an inline confirm box that can sit below the fold of a sheet.
 * Tapping the dimmed backdrop or the cancel text button dismisses.
 */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmTitle,
  busyTitle,
  cancelTitle,
  onConfirm,
  onCancel,
  busy,
  destructive,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmTitle: string;
  busyTitle?: string;
  cancelTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  destructive?: boolean;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onCancel}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onCancel}
        disabled={busy}
        style={styles.dialogOverlay}
      >
        <Pressable
          accessibilityRole="none"
          onPress={() => {}}
          style={styles.dialogCard}
        >
          <Text style={styles.dialogTitle}>{title}</Text>
          <Text style={styles.dialogMessage}>{message}</Text>
          <View style={styles.dialogBtns}>
            <Pressable
              accessibilityRole="button"
              onPress={onConfirm}
              disabled={busy}
              style={[
                destructive ? styles.dialogDestructiveBtn : styles.btnPrimary,
                styles.dialogConfirmBtn,
                busy && { opacity: 0.6 },
              ]}
            >
              <Text style={styles.dialogDestructiveText}>
                {busy && busyTitle ? busyTitle : confirmTitle}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={onCancel}
              disabled={busy}
              hitSlop={8}
              style={styles.dialogCancelBtn}
            >
              <Text style={styles.dialogCancelText}>{cancelTitle}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
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

/** Stroked eye from the approved change-password mockup; slashed when the
 * password is shown. Shared by Field's password toggle and the
 * change-password / recovery screens. */
export function EyeIcon({ shown }: { shown: boolean }) {
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

export function Field({
  label, value, onChangeText, placeholder, multiline,
  secureTextEntry, keyboardType, autoCapitalize, autoCorrect, testID,
  onFocus,
}: {
  label: string; value: string; onChangeText: (t: string) => void;
  placeholder?: string; multiline?: boolean; testID?: string;
  secureTextEntry?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'numeric' | 'decimal-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  /** Called when the field is focused (Sept 28, 2026: the transaction detail
   * screen scrolls the custom-step field into view above the keyboard). */
  onFocus?: () => void;
}) {
  // Show/hide toggle (Sept 2026): every password field gets the approved
  // eye icon inside the field, toggling secureTextEntry. Text fields are
  // untouched.
  const [shown, setShown] = useState(false);
  const isPassword = !!secureTextEntry;
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={isPassword && styles.fieldPwrap}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          multiline={!!multiline}
          secureTextEntry={isPassword && !shown}
          keyboardType={keyboardType ?? 'default'}
          autoCapitalize={autoCapitalize ?? 'sentences'}
          autoCorrect={autoCorrect ?? true}
          onFocus={onFocus}
          testID={testID}
          style={[styles.fieldInput, multiline && styles.fieldInputMultiline, isPassword && styles.fieldInputPassword]}
        />
        {isPassword ? (
          <Pressable
            onPress={() => setShown((s) => !s)}
            accessibilityRole="button"
            accessibilityLabel={shown ? 'Hide password' : 'Show password'}
            accessibilityState={{ selected: shown }}
            testID={testID ? `${testID}-eye` : 'field-eye'}
            style={({ pressed }) => [
              styles.eyeBtn,
              pressed && { backgroundColor: colors.accentSoft },
            ]}
          >
            <EyeIcon shown={shown} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

// Chrome around the sheet's scroll region: grabber + sheet vertical padding.
const SHEET_CHROME = 80;

/**
 * Height of the software keyboard in px, 0 when hidden. Web tracks
 * window.visualViewport (the layout viewport does not shrink for the
 * keyboard on iOS Safari); native tracks Keyboard events. Android is
 * skipped: the OS resizes the window (adjustResize), which
 * useWindowDimensions already reflects.
 *
 * Shared screen-level pattern (Sept 28, 2026, Anuraj: every input in the
 * app stays visible above the keyboard): screens read this hook and add
 * `{ paddingBottom: kbHeight }` to their ScrollView's contentContainerStyle
 * (or their root container). The focused field can then scroll into view
 * above the keyboard instead of being buried behind it — the same
 * lift-by-keyboard-height idea the shared Sheet uses internally.
 */
export function useKeyboardHeight(): number {
  const [kb, setKb] = useState(0);
  useEffect(() => {
    if (Platform.OS === 'web') {
      const vv = (window as unknown as { visualViewport?: VisualViewport }).visualViewport;
      if (!vv) return;
      const update = () => {
        setKb(Math.max(0, window.innerHeight - vv.height - (vv.offsetTop || 0)));
      };
      update();
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
      return () => {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      };
    }
    if (Platform.OS === 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      setKb(e.endCoordinates ? e.endCoordinates.height : 0),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setKb(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return kb;
}

export function Sheet({
  visible, onClose, children, dragToDismiss,
}: {
  visible: boolean; onClose: () => void; children: ReactNode;
  /**
   * Drag the grabber/header down to dismiss (change-password sheet, Sept 26).
   * Off by default — every other sheet keeps its exact current behavior.
   */
  dragToDismiss?: boolean;
}) {
  const translateY = useRef(new Animated.Value(0)).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Keyboard avoidance (Sept 2026): when the software keyboard opens, the
  // whole sheet lifts above it (marginBottom, capped so the sheet top never
  // leaves the screen) so the focused field stays reachable and the save
  // button is never buried — no overlap, no half-buried buttons. Lives here
  // in the SHARED Sheet so every sheet in the app benefits, not just the
  // escrow forms.
  //
  // Detent lock (Sept 28, 2026, Anuraj): the sheet keeps the exact size it
  // opened with — keyboard appearance never resizes it. The open height is
  // snapshotted from the first keyboard-closed layout and applied as a
  // maxHeight on the container; the scroll region is derived from that
  // locked height, never from the keyboard height. Fields below the fold
  // are reached by scrolling inside the sheet.
  const kbHeight = useKeyboardHeight();
  const { height: winHeight } = useWindowDimensions();
  const [openHeight, setOpenHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!visible) setOpenHeight(null);
  }, [visible]);
  // Visible height above the keyboard. Web: iOS Safari never resizes the
  // layout viewport for the keyboard, so subtract the visualViewport delta.
  // Android: the OS already resizes the window (adjustResize), so the
  // Keyboard listener is skipped there and winHeight is the visible height.
  // NOTE: kbHeight is deliberately NOT part of the sheet sizing — the
  // detent lock keeps the open size; the keyboard only lifts the sheet.
  const layoutHeight = Platform.OS === 'web' ? window.innerHeight : winHeight;
  // Chrome around the scroll region (grabber + sheet vertical padding).
  const scrollMaxHeight = Math.max(
    160,
    Math.min(480, (openHeight ?? layoutHeight) - SHEET_CHROME),
  );
  // Lift the sheet above the keyboard but never push its top offscreen.
  const lift = Math.max(0, Math.min(kbHeight, layoutHeight - (openHeight ?? layoutHeight)));

  // A dragged-then-closed sheet must reopen at rest position.
  useEffect(() => {
    if (!visible) translateY.setValue(0);
  }, [visible, translateY]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) =>
        g.dy > 10 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5,
      onPanResponderMove: (_e, g) => {
        if (g.dy > 0) translateY.setValue(g.dy);
      },
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 110 || g.vy > 1.1) {
          translateY.setValue(0);
          onCloseRef.current();
        } else {
          Animated.spring(translateY, {
            toValue: 0, useNativeDriver: true, speed: 24, bounciness: 0,
          }).start();
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(translateY, {
          toValue: 0, useNativeDriver: true, speed: 24, bounciness: 0,
        }).start();
      },
    }),
  ).current;

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.sheetOverlay} onPress={onClose} accessibilityRole="button" accessibilityLabel="Dismiss sheet" />
      <Animated.View
        onLayout={(e) => {
          // Detent lock: the first layout with the keyboard closed is the
          // size the sheet opened with — keep it for this open session.
          if (visible && kbHeight === 0 && openHeight === null) {
            setOpenHeight(e.nativeEvent.layout.height);
          }
        }}
        style={[
          styles.sheet,
          // Detent lock (Sept 28, 2026): the sheet can never grow past the
          // size it opened with — keyboard appearance only lifts it.
          openHeight !== null && { maxHeight: openHeight },
          // Keyboard avoidance (Sept 2026): lift the whole sheet above the
          // keyboard, capped so the sheet top never leaves the screen.
          // (Android: kbHeight is 0 — the OS resizes the window itself via
          // adjustResize.)
          { marginBottom: lift },
          dragToDismiss && { transform: [{ translateY }] },
        ]}
      >
        {dragToDismiss ? (
          <View
            style={styles.grabberZone}
            {...panResponder.panHandlers}
            testID="sheet-grabber-zone"
          >
            <View style={styles.grabber} />
          </View>
        ) : (
          <View style={styles.grabber} />
        )}
        {/* The grabber stays OUTSIDE the scroll region: it is always visible and
            remains the drag-to-dismiss handle, while the content region scrolls.
            (Sept 2026 sheet-scroll fix: sheet content used to grow unbounded and
            overflow small screens, leaving lower fields and the save button
            unreachable. The ScrollView is height-bounded so it scrolls on native
            and on web alike; the 480 bound matches the shared sheet
            pattern.) */}
        <ScrollView
          style={[styles.sheetScroll, { maxHeight: scrollMaxHeight }]}
          contentContainerStyle={styles.sheetScrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          testID="sheet-scroll"
        >
          {children}
        </ScrollView>
      </Animated.View>
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
  fieldPwrap: { position: 'relative', justifyContent: 'center' },
  fieldInputPassword: { paddingRight: 54 },
  eyeBtn: {
    position: 'absolute',
    right: 4,
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
  // Taller drag target around the grabber for drag-to-dismiss sheets.
  grabberZone: {
    alignItems: 'center', paddingVertical: 10, marginTop: -10, marginBottom: 6,
  },
  // Sheet content scroll region (Sept 2026 sheet-scroll fix, Sept 2026
  // keyboard-avoidance update, Sept 28 detent lock). The bound lives on the
  // ScrollView itself — not on the sheet container — so it constrains the
  // scrolling element on native and on web (react-native-web only scrolls a
  // ScrollView with a definite height bound). Matches the shared sheet
  // pattern used by every other sheet in the app. The Sheet component derives
  // maxHeight at render time from the locked open height (detent): the
  // keyboard never resizes the sheet, it only lifts it; the region never
  // exceeds the visible window (minus chrome).
  sheetScroll: {
    maxHeight: 480,
  },
  sheetScrollContent: {
    // Content padding stays on the sheet container; nothing needed here.
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
  dialogOverlay: {
    flex: 1,
    backgroundColor: 'rgba(33,29,23,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  dialogCard: {
    width: '100%',
    maxWidth: 340,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 12,
  },
  dialogTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.ink,
    textAlign: 'center',
    marginBottom: 8,
  },
  dialogMessage: {
    fontSize: 14.5,
    color: colors.body,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 16,
  },
  dialogBtns: {
    alignItems: 'stretch',
  },
  dialogConfirmBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    width: '100%',
  },
  dialogDestructiveBtn: {
    backgroundColor: colors.red,
    borderRadius: radius.button,
  },
  dialogDestructiveText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
  },
  dialogCancelBtn: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialogCancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.accent,
  },
});
