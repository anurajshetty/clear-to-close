// Clear to Close — client "My escrows" list (multi-escrow, Sept 28, 2026).
// Approved mockup 01 · screen 16: one row per escrow for every live device
// link — 2+ valid links route here at boot; 1 link opens directly; 0 links
// route to redeem (see src/lib/bootRoute.ts).
//
// Branding is isolated per row: each row's address, role, realtor name and
// photo arrive through that row's own link — never shared across rows.
// Opening a row loads ONLY that escrow (deep link to its client home).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { auth } from '../../src/lib/auth';
import { store } from '../../src/lib/store-instance';
import { unregisterPushTokenForLink } from '../../src/lib/push';
import { displayPhotoUri } from '../../src/lib/profile';
import { SecondaryButton } from '../../src/components/ui';
import { EscrowListRow } from '../../src/components/EscrowListRow';
import {
  buildEscrowListEntry,
  sortEscrowListEntries,
  type EscrowListEntry,
} from '../../src/lib/escrowList';
import type { ClientView, DeviceClientLink, TcView } from '../../src/lib/types';
import { colors, type } from '../../src/theme';
import { ToastTimer } from '../../src/lib/toast';

type LoadState = 'loading' | 'ready' | 'error';

function summaryForLink(
  link: DeviceClientLink,
  view: ClientView | TcView | null,
): EscrowListEntry['summary'] {
  // TC views carry both checklists; the row shows the active side's counts.
  const base: ClientView | null =
    link.role === 'tc'
      ? ((view as TcView | null)?.buyer ?? (view as TcView | null)?.seller ?? null)
      : ((view as ClientView | null) ?? null);
  return {
    address: base?.address ?? '',
    city: base?.city ?? '',
    done: base?.done ?? 0,
    total: base?.total ?? 0,
    status: base?.status,
    updatedAt: base?.updatedAt,
  };
}

export default function EscrowsList() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ added?: string }>();
  const [state, setState] = useState<LoadState>('loading');
  const [entries, setEntries] = useState<EscrowListEntry[]>([]);
  const [greeting, setGreeting] = useState('Hi there');
  // One-time toast after a successful second redeem (approved copy).
  // The dismiss timer lives inside ToastTimer (src/lib/toast.ts), NOT in
  // the effect below: consuming the `added` param re-renders this screen,
  // and a timer armed in that effect would be cancelled by the effect
  // cleanup — the Sept 28 stuck-toast bug (the toast never dismissed).
  const addedToast = useMemo(() => new ToastTimer(), []);
  const [showAddedToast, setShowAddedToast] = useState(addedToast.visible);
  useEffect(() => addedToast.subscribe(setShowAddedToast), [addedToast]);

  useEffect(() => {
    if (params.added !== '1') return;
    // Consume the flag: a remount (back from an escrow) must not replay it.
    router.setParams({ added: undefined });
    addedToast.show();
  }, [params.added, addedToast]);

  const load = useCallback(() => {
    let active = true;
    setState('loading');
    (async () => {
      try {
        const links = await auth.getClientLinks();
        const rows: EscrowListEntry[] = [];
        for (const link of links) {
          // Validate each link against the server; a revoked/superseded
          // link drops ONLY its own row — never the whole list.
          let valid = true;
          try {
            const res = await store.validateClientLink(link.linkId);
            valid = res.valid;
          } catch {
            valid = true; // Offline: keep the cached row, it still opens.
          }
          if (!valid) {
            await auth.removeClientLink(link.linkId);
            try {
              await unregisterPushTokenForLink(link.linkId);
            } catch {
              // best-effort
            }
            continue;
          }
          // Fetch the view first: it populates the per-escrow profile cache,
          // then resolve the profile — never in parallel, so the profile
          // can never race ahead of the view that seeds it.
          const view =
            link.role === 'tc'
              ? await store.getTcView(link.escrowId)
              : link.role === 'seller'
                ? await store.getSellerView(link.escrowId)
                : await store.getBuyerView(link.escrowId);
          const profile = await store.getLinkedProfile(link.escrowId).catch(() => null);
          if (view == null) continue;
          const name = profile?.name?.trim() || 'Your realtor';
          rows.push(buildEscrowListEntry(link, summaryForLink(link, view), name, displayPhotoUri(profile)));
        }
        if (!active) return;
        if (rows.length === 0) {
          // All links died while we were away — fall back to redeem.
          router.replace('/redeem');
          return;
        }
        const last = links[links.length - 1];
        setGreeting(last?.partyName?.trim() ? `Hi ${last.partyName.trim()}` : 'Hi there');
        setEntries(sortEscrowListEntries(rows));
        setState('ready');
      } catch (err) {
        console.warn('escrow list load failed', err);
        if (active) setState('error');
      }
    })();
    return () => {
      active = false;
    };
  }, [router]);

  useFocusEffect(load);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 18, paddingBottom: insets.bottom + 24 }]}
    >
      <Text style={styles.kicker}>Your escrows</Text>
      <Text style={styles.title}>{greeting}</Text>
      <Text style={styles.sub}>Every escrow you&apos;re invited to, in one place.</Text>

      {state === 'loading' ? (
        <View style={styles.skeletons}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.skeleton} />
          ))}
        </View>
      ) : state === 'error' ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>
            Couldn&apos;t load your escrows. Check your connection and try again.
          </Text>
          <SecondaryButton title="Try again" onPress={load} />
        </View>
      ) : (
        <>
          {entries.map((entry) => (
            <EscrowListRow
              key={entry.link.linkId}
              entry={entry}
              onOpen={() =>
                router.replace(`/client/${entry.link.role}/${entry.link.escrowId}` as never)
              }
            />
          ))}
          <View style={styles.joinWrap}>
            <SecondaryButton
              title="Join another escrow"
              onPress={() => router.push('/redeem')}
            />
          </View>
        </>
      )}
      {showAddedToast ? (
        <Pressable
          style={styles.toast}
          onPress={() => addedToast.dismiss()}
          accessibilityRole="button"
          accessibilityLabel="Dismiss notification"
          testID="added-toast"
        >
          <Text style={styles.toastText}>Added to your escrows.</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper },
  content: { paddingHorizontal: 20 },
  kicker: {
    color: colors.accent,
    fontWeight: '800',
    fontSize: 12,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
  },
  title: { color: colors.ink, fontSize: 26, fontWeight: '800', marginTop: 8, letterSpacing: -0.26 },
  sub: { color: colors.body, fontSize: type.body, marginTop: 6, lineHeight: 22 },
  skeletons: { marginTop: 4 },
  skeleton: {
    height: 76,
    borderRadius: 16,
    backgroundColor: colors.line,
    opacity: 0.45,
    marginTop: 12,
  },
  errorBox: { marginTop: 24, gap: 12 },
  errorText: { color: colors.body, fontSize: type.body, lineHeight: 22 },
  joinWrap: { marginTop: 16 },
  // One-time "Added to your escrows." toast after a second redeem.
  toast: {
    position: 'absolute',
    top: 12,
    left: 20,
    right: 20,
    alignItems: 'center',
    backgroundColor: colors.ink,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  toastText: { color: '#FFFFFF', fontSize: type.body, fontWeight: '700' },
});
