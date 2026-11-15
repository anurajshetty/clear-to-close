// Clear to Close — the persistent Notifications row (Notification
// Re-Ask, approved Nov 14, 2026, spec section 4). ONE shared component
// rendered by both profile surfaces (realtor profile-update and the
// client-facing profile) — never divergent copies.
//
// The row always shows the LIVE permission status ("On" /
// "Off · Turn on"), re-checked on screen focus and on app foreground.
// Tapping mirrors the sheet's two-state behavior: undetermined runs
// the system prompt; denied deep-links to the app's Settings page;
// On also opens Settings (the standard pattern). A fresh grant
// registers this device's token for the role right away (the register
// helpers self-guard). Web renders nothing — push is native-only.
import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import {
  getPushPermission,
  registerPushToken,
  registerRealtorPushToken,
  requestPushPermission,
  type PushAskRole,
  type PushPermissionState,
} from '../lib/push';
import { colors } from '../theme';

export function NotificationRow({ role }: { role: PushAskRole }): React.ReactElement | null {
  const [permission, setPermission] = useState<PushPermissionState | null>(null);

  const refresh = useCallback(() => {
    let active = true;
    if (Platform.OS === 'web') return () => {};
    getPushPermission()
      .then(async (p) => {
        if (!active) return;
        setPermission(p);
        if (p === 'granted') {
          // Self-heal: a grant made in Settings (or just now) registers
          // this device without waiting for the next cold launch.
          if (role === 'realtor') await registerRealtorPushToken();
          else await registerPushToken();
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [role]);

  useFocusEffect(refresh);

  // Foreground return does not refocus the screen: re-check the same way.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const onPress = useCallback(async () => {
    try {
      if (permission === 'undetermined') {
        await requestPushPermission();
        refresh();
      } else {
        // 'denied' can only be fixed in Settings; 'granted' opens
        // Settings by the standard pattern.
        await Linking.openSettings();
      }
    } catch {
      // the row never blocks the profile screen
    }
  }, [permission, refresh]);

  if (Platform.OS === 'web') return null;

  const on = permission === 'granted';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        on ? 'Notifications are on. Open Settings.' : 'Notifications are off. Turn on.'
      }
      testID="notifications-row"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.accentSoft }]}
    >
      <Text style={styles.label}>Notifications</Text>
      <View style={styles.statusWrap}>
        <Text style={on ? styles.statusOn : styles.statusOff}>{on ? 'On' : 'Off · Turn on'}</Text>
        <Text style={styles.chevron}>›</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 52,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  label: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink,
  },
  statusWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusOn: {
    fontSize: 14,
    color: colors.muted,
  },
  statusOff: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.accent,
  },
  chevron: {
    fontSize: 18,
    color: colors.muted,
  },
});
