-- 0012_tc_invite.sql
--
-- Transaction coordinator (TC) invite type (approved Sept 2026):
-- exactly ONE active TC invite per escrow. The TC is separate from the
-- buyer/seller sides: the two-per-side cap is untouched.
--
-- ADDITIVE ONLY: widens the role check constraints on invites/client_links
-- to admit 'tc' (the allowed set only grows; existing buyer/seller rows are
-- unaffected) and extends the invite cap trigger with a role-dependent cap
-- (2 per buyer/seller side, 1 per escrow for 'tc'). No columns dropped, no
-- renames, no data touched. Old code (buyer/seller only) keeps working
-- unchanged against the migrated DB. The get_client_view re-creation below
-- keeps the full 0011 contract (reviews, my_review_id, full-row profile)
-- and adds the TC branch; buyer/seller payloads are unchanged from 0011.

-- Widen role checks (additive: the allowed set only grows).
alter table invites drop constraint if exists invites_role_check;
alter table invites
  add constraint invites_role_check check (role in ('buyer', 'seller', 'tc'));

alter table client_links drop constraint if exists client_links_role_check;
alter table client_links
  add constraint client_links_role_check check (role in ('buyer', 'seller', 'tc'));

-- ------------------------------------------------------------------ cap ----
-- Role-dependent cap, enforced authoritatively in the database (local
-- enforcement in the app store is not enough on its own: synced/direct
-- inserts would otherwise bypass it). Only non-revoked invites count, so
-- revoking frees a slot. The cap check takes a per-(escrow, role) advisory
-- transaction lock so two concurrent inserts cannot both slip under the cap.
--
-- Replaces enforce_two_clients_per_side(): buyer/seller behavior is
-- identical (cap 2); role = 'tc' is capped at 1 per escrow.
create or replace function enforce_invite_caps()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_cap int;
begin
  -- Serialize cap checks per escrow+role: without this, two concurrent
  -- inserts could both count below the cap and push past it.
  perform pg_advisory_xact_lock(
    hashtextextended('invites_cap:' || new.escrow_id::text || ':' || new.role, 0)
  );
  v_cap := case when new.role = 'tc' then 1 else 2 end;
  if (
    select count(*)
    from invites
    where escrow_id = new.escrow_id
      and role = new.role
      and revoked_at is null
  ) >= v_cap then
    raise exception '%', case when new.role = 'tc'
      then 'one transaction coordinator per escrow max — revoke the existing invite to invite someone new'
      else 'two clients per side max — revoke one to invite someone new'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists invites_two_per_side on invites;
drop trigger if exists invites_cap on invites;
create trigger invites_cap
  before insert on invites
  for each row
  execute function enforce_invite_caps();

-- get_client_view: TC branch (Anuraj's decision, Sept 2026 — on a "both"
-- escrow the TC sees BOTH checklists; on a single-side escrow the active
-- side's). ADDITIVE: create or replace only; the buyer/seller branches and
-- validation order are unchanged from 0011 (revoked checks, full-row
-- profile + reviews + my_review_id included). The TC payload carries both
-- step arrays plus an explicit 'role': 'tc' — the client decides which
-- sections are active from the escrow side. Never silently show one side
-- when both exist.
create or replace function get_client_view(p_link_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link client_links%rowtype;
  v_escrow jsonb;
  v_steps jsonb;
  v_buyer_steps jsonb;
  v_seller_steps jsonb;
  v_profile jsonb;
  v_invite_revoked timestamptz;
  v_realtor_id uuid;
  v_my_review_id text;
begin
  select * into v_link from client_links where id = p_link_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_link.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;

  select revoked_at into v_invite_revoked from invites where id = v_link.invite_id;
  if v_invite_revoked is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;

  select to_jsonb(e) into v_escrow from escrows e where e.id = v_link.escrow_id;

  select e.user_id into v_realtor_id from escrows e where e.id = v_link.escrow_id;

  -- Full-row profile (additive): every key old code read stays present;
  -- reviews is the only added key.
  select to_jsonb(p) || jsonb_build_object(
    'reviews', realtor_reviews_json(v_realtor_id)
  )
  into v_profile
  from realtor_profiles p
  where p.user_id = v_realtor_id;

  select id::text into v_my_review_id
  from public.reviews
  where link_id = p_link_id
  limit 1;

  if v_link.role = 'tc' then
    select coalesce(jsonb_agg(to_jsonb(s) order by s.position), '[]'::jsonb)
    into v_buyer_steps
    from steps s
    where s.escrow_id = v_link.escrow_id and s.role = 'buyer';

    select coalesce(jsonb_agg(to_jsonb(s) order by s.position), '[]'::jsonb)
    into v_seller_steps
    from steps s
    where s.escrow_id = v_link.escrow_id and s.role = 'seller';

    return jsonb_build_object(
      'ok', true,
      'role', 'tc',
      'escrow', v_escrow,
      'buyer_steps', v_buyer_steps,
      'seller_steps', v_seller_steps,
      'profile', v_profile,
      'my_review_id', v_my_review_id
    );
  end if;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.position), '[]'::jsonb)
  into v_steps
  from steps s
  where s.escrow_id = v_link.escrow_id and s.role = v_link.role;

  if v_link.role = 'buyer' then
    return jsonb_build_object(
      'ok', true,
      'escrow', v_escrow,
      'buyer_steps', v_steps,
      'profile', v_profile,
      'my_review_id', v_my_review_id
    );
  else
    return jsonb_build_object(
      'ok', true,
      'escrow', v_escrow,
      'seller_steps', v_steps,
      'profile', v_profile,
      'my_review_id', v_my_review_id
    );
  end if;
end;
$$;

-- The grant from 0001_init.sql still applies to the replaced function
-- (grants survive create or replace); restated here for paste-order safety.
grant execute on function get_client_view(uuid) to anon, authenticated;
