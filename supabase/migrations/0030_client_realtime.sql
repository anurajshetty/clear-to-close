-- Clear to Close — migration 0030: secure realtime for client views.
--
-- Client views (buyer/seller/TC) currently converge on foreground-focus
-- refetch only. This migration wires real Supabase Realtime
-- (postgres_changes) so a realtor check-off, key-date change, escrow
-- metadata edit, or link revocation reaches the open client screen without
-- a foreground round-trip.
--
-- SECURITY MODEL (Anuraj's rule: clients authenticate by device link, not
-- by login — there is no client login and the anon key alone proves
-- nothing):
--
--   1. The client calls the `client-realtime-token` Edge Function with its
--      (link_id, device_id). The function validates the device link
--      server-side (link exists, revoked_at IS NULL, invite not revoked,
--      device_id matches the bound device) and mints a SHORT-LIVED JWT
--      (15 min TTL) signed with the project's JWT secret, carrying:
--        role: 'anon', device_link_id, escrow_id, link_role.
--      A forged token is impossible without the JWT secret; an expired or
--      tampered token is rejected by signature/expiry checks.
--
--   2. The client opens its realtime channel with that token
--      (realtime.setAuth). Every postgres_changes event is filtered by
--      THESE RLS policies, evaluated per row on the server:
--        - client_links: the client sees ONLY its own link row
--          (id = token device_link_id). revoked_at is deliberately NOT
--          filtered out, so the client observes its own revocation and
--          routes to the link-dead state immediately.
--        - steps / escrows / realtor_profiles: rows for the token's escrow
--          ONLY, and ONLY while the token's device link is still live
--          (EXISTS revoked_at IS NULL). Revocation cuts the event stream
--          at the database the moment revoked_at is set — even if the
--          client's socket stays open, no further data events arrive.
--
--   3. The plain anon key (no token claims) matches NO rows: every policy
--      requires the device_link_id / escrow_id JWT claims, which the stock
--      anon key does not carry. Realtor rows stay owner-only
--      (auth.uid() = user_id); these policies are SELECT-only, TO anon,
--      and change nothing about realtor access.
--
--   4. The client NEVER applies realtime payloads directly: on any data
--      event it re-pulls get_client_view (server is the single source of
--      truth). Realtime is a read-only invalidation signal.
--
-- ADDITIVE-ONLY: adds tables to the supabase_realtime publication, grants
-- SELECT to anon (RLS still enforced), and adds four SELECT policies. No
-- existing policy, function, or trigger is touched.
--
-- KILL SWITCH: revoke realtime without touching data —
--   alter publication supabase_realtime drop table public.steps;
-- (repeat per table) — or drop the four ctc_client_* policies. Clients
-- degrade to foreground-focus refetch automatically.
--
-- DEPLOY ORDER: apply in the dashboard SQL editor any time; the app only
-- subscribes once the `client-realtime-token` Edge Function is deployed.
-- Until both are live, clients keep the foreground-refetch behavior.
--
-- NUMBERING: 0030. Multi-escrow was reserved 0022+ — it must use 0022-0029
-- or 0031+, not 0030.

-- ------------------------------------------------- publication members --
-- Idempotent: safe to re-run (dashboard re-pastes happen).

do $$
declare
  t text;
begin
  foreach t in array array['escrows', 'steps', 'client_links', 'realtor_profiles']
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

-- RLS still enforced: these grants only take effect through the policies
-- below (a bare anon key with no token claims matches zero rows).
grant select on public.escrows to anon;
grant select on public.steps to anon;
grant select on public.client_links to anon;
grant select on public.realtor_profiles to anon;

-- ------------------------------------------- token-claim helpers --
-- Null-safe readers for the client realtime JWT claims. SECURITY DEFINER
-- so the EXISTS liveness checks below don't recurse through RLS.

create or replace function ctc_client_link_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif(auth.jwt() ->> 'device_link_id', '')::uuid
$$;

create or replace function ctc_client_escrow_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select nullif(auth.jwt() ->> 'escrow_id', '')::uuid
$$;

-- A device link is "live" while it exists and neither it nor its invite
-- has been revoked (mirrors get_client_view's revoked checks).
create or replace function ctc_client_link_live(p_link_id uuid, p_escrow_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from client_links cl
    join invites i on i.id = cl.invite_id
    where cl.id = p_link_id
      and cl.escrow_id = p_escrow_id
      and cl.revoked_at is null
      and i.revoked_at is null
  )
$$;

-- ------------------------------------------------- RLS policies --
-- SELECT-only, TO anon. The stock anon key carries no device_link_id /
-- escrow_id claims, so these policies expose nothing to it.

drop policy if exists client_links_client_self on public.client_links;
create policy client_links_client_self on public.client_links
  for select
  to anon
  using (id = ctc_client_link_id());
-- NOTE: no revoked_at filter here — the client must SEE its own
-- revocation to route to the link-dead state.

drop policy if exists steps_client_live on public.steps;
create policy steps_client_live on public.steps
  for select
  to anon
  using (
    escrow_id = ctc_client_escrow_id()
    and ctc_client_link_live(ctc_client_link_id(), steps.escrow_id)
  );

drop policy if exists escrows_client_live on public.escrows;
create policy escrows_client_live on public.escrows
  for select
  to anon
  using (
    id = ctc_client_escrow_id()
    and ctc_client_link_live(ctc_client_link_id(), escrows.id)
  );

drop policy if exists realtor_profiles_client_live on public.realtor_profiles;
create policy realtor_profiles_client_live on public.realtor_profiles
  for select
  to anon
  using (
    user_id = (
      select e.user_id from public.escrows e where e.id = ctc_client_escrow_id()
    )
    and ctc_client_link_live(ctc_client_link_id(), ctc_client_escrow_id())
  );
