// Clear to Close — client realtime subscription hook.
//
// Mounts the secure realtime manager (src/lib/clientRealtime.ts) for one
// linked escrow once the link gate passes. On any data event it re-runs
// the screen's data load (server-first pull); on link revocation it
// routes to /link-dead. Any realtime failure degrades silently to the
// existing focus/foreground refetch — this hook never surfaces errors.
import { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { auth } from '../lib/auth';
import { startClientRealtime } from '../lib/clientRealtime';

export function useClientRealtime(
  escrowId: string,
  opts: {
    /** Start only once the link gate has validated the link. */
    enabled: boolean;
    /** The screen's server-first data load (e.g. getBuyerView pull). */
    onDataChanged: () => void;
  },
) {
  const router = useRouter();
  const cbRef = useRef(opts.onDataChanged);
  cbRef.current = opts.onDataChanged;

  useEffect(() => {
    if (!opts.enabled || !escrowId) return;
    let cancelled = false;
    let handle: { stop: () => void } | null = null;
    auth
      .getClientLinks()
      .then((links) => {
        const link = links.find((l) => l.escrowId === escrowId);
        if (cancelled || !link || !link.linkId || !link.deviceId) {
          return;
        }
        handle = startClientRealtime({
          linkId: link.linkId,
          deviceId: link.deviceId,
          escrowId,
          onDataChanged: () => {
            try {
              cbRef.current();
            } catch {
              // The screen's load never throws (it catches internally);
              // this is a final backstop so a bad callback can't kill the
              // socket loop.
            }
          },
          onLinkDead: () => {
            router.replace('/link-dead');
          },
        });
      })
      .catch(() => {
        // Link read failed: leave realtime off; the gate + focus refetch
        // remain the backstop.
      });
    return () => {
      cancelled = true;
      if (handle) handle.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escrowId, opts.enabled]);
}
