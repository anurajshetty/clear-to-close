import { useEffect } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { initCloudSync } from '../src/lib/store-instance';

export default function RootLayout() {
  useEffect(() => {
    // Boot-time cloud connectivity check (auth + read/write round-trip).
    // Never blocks UI and never throws: on failure sync stays dormant and
    // the app works as the local-only v1.
    void initCloudSync().catch(() => {});
  }, []);

  return (
    <>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="escrow/[id]" />
        <Stack.Screen name="share/[id]" />
        <Stack.Screen name="redeem" />
        <Stack.Screen name="profile-setup" />
        <Stack.Screen name="client/buyer/[id]" />
        <Stack.Screen name="client/seller/[id]" />
        <Stack.Screen name="client/profile" />
      </Stack>
    </>
  );
}
