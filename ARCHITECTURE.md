# Clear to Close — Architecture Principles

Non-negotiable on all future work. Set by Anuraj, Sept 27, 2026
(industry-standard patterns, from the real-time sync rebuild).

## 1. Single source of truth

The server owns every piece of data. The app never holds a competing
"truth." There is exactly one authoritative copy of each record, and it
lives in Supabase.

## 2. Cache semantics

Local data is explicitly a cache. It knows it may be stale: it refreshes
on open, on foreground return, and on pull-to-refresh — and it NEVER
overrides the server. A cache is a performance convenience, not a second
database. There are no unconfirmed local writes: a user-initiated write
applies to the local cache only after the server confirms it, and a
failed save leaves local state exactly as it was.

## 3. Confirmed-or-loud writes

Every user-initiated save writes to the server and waits for
confirmation. Optimistic UI is allowed only if a rejected save visibly
rolls back with a plain-words error — never show "saved" unconfirmed.
A failed save is a loud, on-screen event: what failed, why, and the next
step. Nothing may look saved when it wasn't.

## 4. Real-time for shared data

Realtor and client views of the same escrow stay live via server push
(Supabase Realtime), not manual refresh. Any two screens showing the same
record converge without user action. Where realtime cannot reach
(offline, unauthenticated client links), the fallback is explicit
server-first refetch on focus/foreground — never stale-cache service.

Implemented for client views (Sept 29, 2026):

- Clients have no login, so they authenticate by device link: the
  `client-realtime-token` Edge Function validates (link_id, device_id)
  server-side and mints a 15-minute JWT signed with the project JWT
  secret (claims: `device_link_id`, `escrow_id`, `link_role`). The client
  passes it to `realtime.setAuth()` on a dedicated supabase client.
- Migration 0030 puts `escrows`, `steps`, `client_links`, and
  `realtor_profiles` on the `supabase_realtime` publication and adds four
  SELECT-only TO anon RLS policies keyed on those claims. Steps, escrows,
  and profiles are admitted only for the token's escrow AND only while
  the device link is live (link and invite `revoked_at IS NULL`) — a
  revoked link's event stream dies at the database immediately. The
  client's own link row is visible unfiltered so the client observes its
  own revocation and routes to /link-dead without a foreground
  round-trip. The stock anon key (no claims) matches zero rows.
- Realtime is a read-only invalidation signal: on any data event the
  client re-pulls `get_client_view` (debounced 750 ms to coalesce rapid
  check-offs). Payloads are never applied directly, so there is no
  client-side conflict surface — the server remains the single source of
  truth and the synchronous-writes model is untouched.
- Any failure (no env, mint failure, socket error, channel close)
  degrades silently to the existing focus/foreground refetch, with
  backoff reconnect. Nothing realtime ever throws to the UI.

## 5. Designed conflict rules

Any situation where two writers can disagree gets an explicit,
documented resolution rule (e.g. last-write-wins by server timestamp,
with the timestamp as the arbiter). "Whichever syncs first wins" is never
acceptable. The rule for each entity lives next to the code that writes
it, and conflicting writes are logged so the resolution is auditable.

---

Operational corollaries (from the Sept 27 sync rebuild):

- PUSH happens only as the direct result of an explicit user action
  (tap Save, check a step, generate an invite, close a deal). The app
  never pushes saved local data on boot or foreground return — the old
  boot push-reconcile pattern is deleted.
- Boot, refresh, and foreground return are PULL: read fresh server state
  into the app. A clean local copy never overwrites the server.
- If a user taps Save while a pull is in flight, the explicit push still
  goes through (user intent wins); the save's confirmation is the last
  word, and a pull must not clobber an in-flight save's result.

Synchronous writes (Anuraj, Sept 28, 2026 — every user-initiated write):

1. Await server confirmation. No optimistic commit, no background queue.
2. Apply server first, local cache second — local commits only after the
   server effect confirms.
3. Throw a plain-language error on failure; failure is loud and on-screen.
4. Leave local state unchanged on failure (byte-identical — pinned by
   tests on every write).
5. Fail fast offline with "couldn't reach the server" style copy.
6. Have a timeout (15s; 30s for profile-with-media, cancel, close).
7. Create no user-action outbox entry. The user-action outbox is retired:
   one final drain of legacy queued operations runs on upgrade, then the
   queue is gone (remaining code is legacy-only: read/clear/retry of old
   failures plus the identity-boundary wipe).
8. Recover safely: crash before confirmation → local unchanged; crash
   after confirmation but before local commit → the next pull heals the
   local cache from server truth.
9. Multi-step effects (cancel, close, bulk checklist save) are sequential,
   NOT one DB transaction — a partway failure leaves local unchanged, the
   user still sees the pre-action state, and retry is idempotent.
   Invite-revoking effects revoke the invite row FIRST so a lookup failure
   can never strand a live link on a live code.
10. Server-authoritative identity data only: device links killed via a live
    server link query, never by trusting locally held link ids. Client
    redeem goes through the redeem_invite RPC as the single authority —
    no local fallback (an offline client is never shown an escrow the
    server does not recognize).
11. Photo/banner uploads go to UNIQUE per-upload Storage paths; the row
    upserts carrying nulled + new URLs; removed files are deleted only
    after the row confirms. A row failure orphans an unreferenced object
    instead of changing what clients see.
- Failure records (sync errors) are identity-bound, persist across
  restarts, clear on successful retry, and wipe on logout.
- Diagnosis discipline: reports separate CONFIRMED (with exact evidence)
  from ASSUMED (labeled with confidence and what would confirm/refute it).
