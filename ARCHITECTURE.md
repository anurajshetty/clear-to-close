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
database. Any local write that has not been confirmed by the server is
marked unconfirmed, not treated as fact.

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
- Failure records (sync errors) are identity-bound, persist across
  restarts, clear on successful retry, and wipe on logout.
- Diagnosis discipline: reports separate CONFIRMED (with exact evidence)
  from ASSUMED (labeled with confidence and what would confirm/refute it).
