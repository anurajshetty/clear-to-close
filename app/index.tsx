import { StyleSheet, Text, View } from 'react-native';

/**
 * Placeholder home screen (scaffold only). The realtor-centered product UI
 * is built after Anuraj's details + approved designer mockups.
 */
export default function Home() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Realtor App</Text>
      <Text style={styles.subtitle}>
        Scaffold is live. Product screens arrive after design.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FAF7F2',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    color: '#2F2B27',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#5C554D',
    textAlign: 'center',
  },
});
