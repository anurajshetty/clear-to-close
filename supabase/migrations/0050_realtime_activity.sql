-- Clear to Close — migration 0050: realtime for team (realtor) views.
--
-- Live team updates (Nov 2026): when an Associate or TC updates an
-- escrow or checks a step, the owner's open screens must reflect it
-- without closing and reopening the app. The app subscribes to
-- postgres_changes as an INVALIDATION-ONLY signal and re-pulls through
-- its existing gated reads; wire payloads are never applied.
--
-- This migration is the ONLY server delta, and it is publication-only:
-- public.escrow_activity (migration 0044) joins the supabase_realtime
-- publication. That is the one team table the screens need that 0030
-- did not already cover.
--
-- PUBLICATION MEMBERSHIP after this migration:
--   - escrows, steps, client_links — added by 0030 (client views).
--   - escrow_activity — added HERE.
--   - realtor_profiles — added by 0030, later REMOVED (dashboard fix,
--     codified in 0035); it stays OFF realtime.
--   - escrow_team_grants — deliberately NOT a member: it has no direct
--     SELECT grant for authenticated by design, so it is not
--     subscribable; roster changes ride escrow_activity events (the
--     team RPCs log invite/member activity rows), with focus and
--     foreground pulls as the convergence backstop.
--
-- NO grants, NO policies, NO functions: Realtime evaluates the
-- EXISTING SELECT policies per subscriber —
--   escrows_select (0045: owner tuple or escrow_access_role),
--   steps_select (0044: escrow_access_role is not null),
--   escrow_activity_select (0044, with its SELECT grant to
--   authenticated) —
-- so a subscriber receives exactly the rows it could already read, a
-- removed member's stream goes silent the moment the grant ends, and
-- a never-member receives nothing. Authorization needed no change.
--
-- KILL SWITCH: revoke without touching data —
--   alter publication supabase_realtime drop table public.escrow_activity;
-- Screens degrade to focus/foreground pulls automatically.
--
-- DEPLOY ORDER: apply in the dashboard SQL editor; the app build with
-- the teamRealtime subscriptions ships alongside. Until both are live,
-- behavior is exactly today's focus/foreground convergence.
--
-- NUMBERING: 0050.

-- ------------------------------------------------- publication member --
-- Idempotent: safe to re-run (dashboard re-pastes happen), in the same
-- DO-block style as 0030.

do $$
declare
  t text;
begin
  foreach t in array array['escrow_activity']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end
$$;
