// ScreenErrorBoundary — the visible fallback for a render crash
// (Oct 22, 2026). Before this existed, an uncaught render error on a
// screen unmounted the whole tree and left a blank white page with
// no message and no way out (the escrow detail hooks-order crash).
// The boundary catches render-phase errors, logs them for diagnosis,
// and shows a plain fallback with a working back action instead.
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, radius } from '../theme';

interface Props {
  /** Title line for the fallback (e.g. the screen's name). */
  title: string;
  /** Label for the fallback's action button. */
  actionLabel: string;
  onAction: () => void;
  children: React.ReactNode;
}

interface State {
  failed: boolean;
}

export class ScreenErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.warn('ScreenErrorBoundary caught a render error', error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View style={styles.center} testID="screen-error-fallback">
        <Text style={styles.title}>{this.props.title}</Text>
        <Text style={styles.body}>
          Something went wrong showing this screen. Your data is safe.
        </Text>
        <Pressable
          style={styles.btn}
          onPress={this.props.onAction}
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>{this.props.actionLabel}</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: colors.paper,
  },
  title: { fontSize: 18, fontWeight: '700', color: colors.ink, marginBottom: 8 },
  body: {
    fontSize: 14,
    color: colors.muted,
    textAlign: 'center',
    marginBottom: 20,
  },
  btn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: radius.button,
  },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
