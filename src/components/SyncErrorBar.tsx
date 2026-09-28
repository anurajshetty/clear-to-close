// Clear to Close — SyncErrorBar: the on-screen sync failure surface.
//
// Mounted once in app/_layout.tsx, above the router stack. Whenever a
// realtor write fails to reach the server, the failure is recorded in
// src/lib/syncErrors.ts and THIS bar shows it: what failed, why in plain
// words, and the next step (Retry, or Dismiss for final rejections).
//
// It is persistent and unmissable by design — never a toast that vanishes.
// Retryable records clear the moment their write lands; final rejections
// are dismissed by the user. It renders only for the realtor role: client
// devices never see it.
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { auth } from '../lib/auth';
import { store } from '../lib/store-instance';
import { syncErrorHeadline, type SyncError } from '../lib/syncErrors';
import { colors } from '../theme';

export function SyncErrorBar(): React.ReactElement | null {
  const [errors, setErrors] = useState<SyncError[]>([]);
  const [isRealtor, setIsRealtor] = useState(false);
  // iOS: the bar sits above the router stack with no screen chrome of its
  // own, so without the top inset it renders under the notch/status bar.
  // On web the inset is 0 — no-op there.
  const insets = useSafeAreaInsets();

  useEffect(() => {
    let active = true;
    void auth
      .getRole()
      .then((r) => {
        if (active) setIsRealtor(r === 'realtor');
      })
      .catch(() => {});
    const refresh = () => {
      void store
        .getSyncErrors()
        .then((list) => {
          if (active) setErrors(list);
        })
        .catch(() => {});
    };
    refresh();
    const off = store.onSyncErrors(refresh);
    return () => {
      active = false;
      off();
    };
  }, []);

  const onRetry = useCallback(() => {
    void store.retrySync().catch(() => {});
  }, []);

  const onDismiss = useCallback((key: string) => {
    void store.dismissSyncError(key).catch(() => {});
  }, []);

  if (!isRealtor || errors.length === 0) return null;

  return (
    <View style={[styles.bar, { paddingTop: 10 + insets.top }]} testID="sync-error-bar">
      {errors.map((e) => (
        <View key={e.key} style={styles.row}>
          <View style={styles.texts}>
            <Text style={styles.headline}>{syncErrorHeadline(e)}</Text>
            <Text style={styles.why}>{e.why}</Text>
            <Text style={styles.hint}>{e.hint}</Text>
          </View>
          <View style={styles.actions}>
            {e.retryable ? (
              <TouchableOpacity
                style={styles.retry}
                onPress={onRetry}
                testID="sync-error-retry"
                accessibilityRole="button"
                accessibilityLabel="Retry sending updates"
              >
                <Text style={styles.retryText}>Retry</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={styles.retry}
                onPress={() => onDismiss(e.key)}
                testID="sync-error-dismiss"
                accessibilityRole="button"
                accessibilityLabel="Dismiss"
              >
                <Text style={styles.retryText}>Dismiss</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.red,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  texts: {
    flex: 1,
    paddingRight: 12,
  },
  headline: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    marginBottom: 2,
  },
  why: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 18,
    opacity: 0.95,
  },
  hint: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 18,
    fontWeight: '700',
    marginTop: 2,
  },
  actions: {
    justifyContent: 'center',
  },
  retry: {
    backgroundColor: '#FFFFFF',
    borderRadius: 999,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  retryText: {
    color: colors.red,
    fontSize: 14,
    fontWeight: '800',
  },
});
