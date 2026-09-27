// Clear to Close — client link gate.
// Every client escrow screen validates the stored device client link on
// focus, BEFORE the escrow renders. A revoked/superseded link routes to
// /link-dead — never a stale or half-loaded escrow. A network-level failure
// shows an explicit loading→retry state instead of silently stalling.
//
// Validation uses the public cloud gate (no realtor session required on a
// client device): when the cloud is reachable, get_client_view is the
// authority and detects a remotely superseded link; otherwise the local
// link record decides.
import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { auth } from '../lib/auth';
import { store } from '../lib/store-instance';
import type { ClientRole } from '../lib/types';

export type ClientGateState = 'checking' | 'valid' | 'error';

export function useClientLinkGate(
  escrowId: string,
  role: ClientRole,
  opts?: {
    /**
     * Foreground data refresh (Sept 2026): invoked on foreground return,
     * right after the silent link revalidation. The screen's useFocusEffect
     * does NOT fire on foreground, so without this the client would keep
     * rendering the stale snapshot even though fresh data is available —
     * pass the screen's data-load here so refresh/foreground converges.
     */
    onForegroundRefresh?: () => void;
  },
) {
  const router = useRouter();
  const [gateState, setGateState] = useState<ClientGateState>('checking');

  const check = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!escrowId) return;
      const silent = opts?.silent === true;
      if (!silent) setGateState('checking');
      try {
        const link = await auth.getClientLink();
        if (!link || link.escrowId !== escrowId || link.role !== role || !link.linkId) {
          router.replace('/link-dead');
          return;
        }
        const res = await store.validateClientLink(link.linkId);
        if (res.valid) {
          if (!silent) setGateState('valid');
        } else {
          router.replace('/link-dead');
        }
      } catch (err) {
        console.warn('client link validation failed', err);
        if (!silent) setGateState('error');
      }
    },
    [escrowId, role, router],
  );

  useFocusEffect(
    useCallback(() => {
      check();
    }, [check]),
  );

  // Anuraj bug (Sept 2026): an already-open client app never re-focused its
  // screen when foregrounded, so a close/revocation that landed while the
  // app was backgrounded never took effect on the open escrow. Revalidate
  // silently on foreground: a dead link routes to /link-dead; a live link
  // leaves the rendered view untouched (no loading flash).
  // Sept 2026 foreground-refresh fix: the silent revalidation now lands the
  // fresh get_client_view payload in the snapshot caches (see
  // validateClientLink), and the screen reloads its data through
  // onForegroundRefresh — the useFocusEffect above does not fire on
  // foreground, so without this the stale profile would stay rendered.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void check({ silent: true });
        opts?.onForegroundRefresh?.();
      }
    });
    return () => sub.remove();
  }, [check, opts?.onForegroundRefresh]);

  return { gateState, retry: check };
}
