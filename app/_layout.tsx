import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

export default function RootLayout() {
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
