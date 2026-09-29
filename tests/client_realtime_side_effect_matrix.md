# Clear to Close — secure realtime side-effect matrix (Sept 2026)

Every subscribed surface and every lifecycle edge the realtime build
touches. Each cell is either covered by an automated test (named) or an
explicit MANUAL cell (Anuraj's iPhone/browser pass — never claimed
without evidence).

## Subscribed surfaces

| Surface | Event | Expected | Evidence |
|---|---|---|---|
| Buyer checklist | realtor checks/unchecks/adds/reorders/deletes a buyer step | client re-pulls; updated checklist renders | `tests/client_realtime.test.ts` t_dataEventsDebounced (wiring) + MANUAL live check-off |
| Seller checklist | same for seller steps | same | same as buyer |
| TC view (both checklists) | step events carry no role filter (escrow-scoped) | both buyer+seller sections re-pull | t_dataEventsDebounced + MANUAL |
| Key dates sheet | realtor edits closing/inspection/appraisal/loan dates | escrows UPDATE -> re-pull; sheet shows new dates | t_dataEventsDebounced (escrows binding) + MANUAL |
| Escrow metadata (address, status, close date) | realtor edits escrow | re-pull | same |
| Realtor profile (photo/name) | realtor updates profile | realtor_profiles -> re-pull; top card updates | t_happyPathWiring (binding) + MANUAL |
| Own link revocation | realtor revokes/regenerates invite | client_links UPDATE w/ revoked_at -> onLinkDead -> /link-dead, channel torn down | t_revokeRoutesToLinkDead |
| Link dead at subscribe | token mint rejected (revoked/invalid/device_mismatch) | onLinkDead immediately, no channel, no retry loop | t_serverSaysDeadOnMint |

## Lifecycle / edge cases

| Case | Expected | Evidence |
|---|---|---|
| Realtime unavailable (offline, socket failure, channel error/closed) | silent degrade to foreground-focus refetch; reconnect with backoff (2s/5s/15s/30s) | t_socketErrorReconnects, t_mintNetworkFailureRetries |
| Supabase not configured (no env) | manager returns null; no fetch, no crash | t_unconfigured |
| Missing link/device id | no handle, no fetch | t_missingLink |
| Token expiry | proactive refresh 2 min before expiry via setAuth; no channel reopen | t_tokenRefresh |
| Token refresh fails transiently | old token kept until expiry; expiry close drives reconnect | code path (refreshToken) + MANUAL long-session |
| Rapid check-offs (realtor taps 3 steps fast) | coalesced into ONE re-pull (750 ms debounce) | t_dataEventsDebounced |
| Unmount / screen change | stop(): channel removed, timers cleared, no callbacks after | t_stopIsClean |
| Two mounts, same escrow | registry dedup: one channel, one mint | t_dedupPerEscrow |
| Multi-escrow (future) | one manager per linked escrow (keyed registry); revoke kills only that escrow's channel | design + registry; MANUAL when multi-escrow ships |
| Closed/cancelled escrow | escrow row UPDATE (status) -> re-pull; client sees locked state via existing status rendering | t_dataEventsDebounced (escrows binding) + MANUAL |
| Dual-agency both-side escrow (TC link) | escrow-scoped filters deliver both roles' steps; RLS admits only the token escrow | design + MANUAL |
| Code regenerate (old device) | old link revoked_at set -> old device's token mint rejected / live channel's link row flips -> /link-dead; new device mints fresh | t_revokeRoutesToLinkDead, t_serverSaysDeadOnMint |
| Revoked link, socket still open | 0030 liveness check fails at the DB: no further steps/escrows/profile events delivered even before the client reacts | tests/client_realtime_migration.py (liveness EXISTS) + MANUAL |
| Forged/expired token | signature/expiry rejected by Supabase; channel never opens | design (HS256 + JWT secret) + MANUAL negative |
| Plain anon key, no token | zero rows match any client policy (claims required) | migration test (null-safe claim readers) + MANUAL negative |
| Realtor views | untouched: realtor sessions never call startClientRealtime; owner RLS policies unchanged | code (hook only in app/client/*) + migration test |
| Synchronous writes model | realtime is reads-only; data events trigger get_client_view re-pull, never direct payload application; no optimistic UI | t_dataEventsDebounced (pull, not apply) |
| Battery/background iOS | socket suspends in background; foreground return still runs the silent link revalidation + data load (existing gate) — realtime is additive, never the only path | design + MANUAL (background/foreground cycle) |
| Web tab hidden | same as iOS: visibility return triggers focus effects; realtime resumes via reconnect backoff | design + MANUAL |
| Em-dash rule | no user-facing copy added by this change (no new strings) | tests/em_dash_sweep.py (suite-wide) |

## Conflict rules (ARCHITECTURE.md principle 5)

Two-writer cases and their explicit rules:

1. **Realtor writes vs client reads**: the server is the single source of
   truth. A realtime event never mutates local state directly; it
   triggers a server-first re-pull (get_client_view). The pull result is
   the last word. No client-side conflict is possible because the client
   performs no writes.
2. **Rapid realtor edits**: the 750 ms debounce coalesces bursts; the
   re-pull reads the latest committed state, so intermediate states are
   never rendered as final.
3. **Revoke racing an in-flight re-pull**: the revoked client may pull
   once more before the link-dead route lands; get_client_view itself
   rejects revoked links, so the pull returns ok:false and the gate
   routes to /link-dead. The 0030 liveness check additionally stops new
   events at the DB.
4. **Token refresh racing channel close**: setAuth failure falls back to
   the reconnect path, which mints a fresh token; duplicate channels are
   impossible (teardownChannel runs before every connect).
