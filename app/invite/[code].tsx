// Clear to Close — branded invite deep link (Sept 2026).
//
// /invite/<code>?name=<party>: forwards to the single redeem form with the
// code and name pre-filled (both editable). The redeem form resolves the
// realtor branding and shows it on the same screen. No separate welcome
// step; the server validates the name authoritatively at redeem time.
import { useEffect } from 'react';
import { ActivityIndicator, SafeAreaView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { colors } from '../../src/theme';

export default function InviteDeepLink() {
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string; name?: string }>();
  const rawCode = Array.isArray(params.code) ? params.code[0] : params.code;
  const rawName = Array.isArray(params.name) ? params.name[0] : params.name;
  const code = (rawCode ?? '').trim().toUpperCase();

  useEffect(() => {
    const q = [`code=${encodeURIComponent(code)}`];
    if (rawName) q.push(`name=${encodeURIComponent(rawName)}`);
    router.replace(`/redeem?${q.join('&')}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
