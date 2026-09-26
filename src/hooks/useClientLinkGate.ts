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
import { useCallback, useState } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { auth } from '../lib/auth';
import { store } from '../lib/store-instance';
import type { ClientRole } from '../lib/types';

export type ClientGateState = 'checking' | 'valid' | 'error';

export function useClientLinkGate(escrowId: string, role: ClientRole) {
  const router = useRouter();
  const [gateState, setGateState] = useState<ClientGateState>('checking');

  const check = useCallback(async () => {
    if (!escrowId) return;
    setGateState('checking');
    try {
      const link = await auth.getClientLink();
      if (!link || link.escrowId !== escrowId || link.role !== role || !link.linkId) {
        router.replace('/link-dead');
        return;
      }
      const res = await store.validateClientLink(link.linkId);
      if (res.valid) {
        setGateState('valid');
      } else {
        router.replace('/link-dead');
      }
    } catch (err) {
      console.warn('client link validation failed', err);
      setGateState('error');
    }
  }, [escrowId, role, router]);

  useFocusEffect(
    useCallback(() => {
      check();
    }, [check]),
  );

  return { gateState, retry: check };
}
