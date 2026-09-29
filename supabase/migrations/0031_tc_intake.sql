-- 0031_tc_intake.sql — TC intake v1 (Sept 29, 2026, Anuraj-approved mockup 04).
--
-- The realtor's listing-details intake, one row per escrow. Server is the
-- source of truth; the app's local intake is explicitly a cache.
--
-- ACCESS MODEL:
--   - The realtor (owner) reads/writes their own rows directly
--     (authenticated + RLS auth.uid() = owner_id).
--   - Anonymous clients can NEVER query this table directly (no grant, RLS
--     denies everything else).
--   - The TC reads the intake ONLY through the SECURITY DEFINER
--     get_client_view RPC, which runs as the table owner and embeds the
--     intake in the tc branch. The function selects tc_intakes.data only
--     (never to_jsonb of the row), so the TC never sees owner_id or other
--     row metadata.
--   - Buyer and seller RPC branches carry NO tc_intake key at all (not
--     even null) — intake data never reaches buyer/seller client views.
--
-- No push notification and no direct TC write path by design.
-- Anuraj applies this in the Supabase dashboard (SQL editor), same as 0008.

-- ---------------------------------------------------------------- table --
create table if not exists tc_intakes (
  escrow_id uuid primary key references escrows(id) on delete cascade,
  owner_id uuid not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The app stamps owner_id = auth.uid() and updated_at on every upsert
-- (the same convention as the other tables — no trigger needed).
alter table tc_intakes enable row level security;

-- Owner-only direct access: the realtor's own session.
drop policy if exists tc_intakes_owner on tc_intakes;
create policy tc_intakes_owner on tc_intakes
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- Realtor sessions get direct table access; anon gets nothing (the table is
-- unreadable to clients except through get_client_view's tc branch).
grant select, insert, update, delete on tc_intakes to authenticated;

-- ------------------------------------------------- get_client_view RPC --
-- Replaced in full (same pattern as 0017): the tc branch now embeds the
-- saved intake under 'tc_intake' (the data payload only). Buyer/seller
-- branches are byte-identical to 0017 — no intake key.
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
  v_tc_intake jsonb;
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

  -- 0015: the escrow lifecycle status is an explicit contract key.
  select to_jsonb(e) || jsonb_build_object('status', e.status)
  into v_escrow from escrows e where e.id = v_link.escrow_id;

  select e.user_id into v_realtor_id from escrows e where e.id = v_link.escrow_id;

  -- 0017: explicit profile field list (email stays realtor-side only).
  select jsonb_build_object(
    'name', p.name,
    'photo_url', p.photo_url,
    'banner_image', p.banner_image,
    'about', p.about,
    'years_experience', p.years_experience,
    'areas_served', p.areas_served,
    'phone', p.phone,
    'dre_license', p.dre_license,
    'realty_group', p.realty_group,
    'rating', p.rating,
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

    -- 0031: the saved intake rides the tc branch only, as the data
    -- payload (owner_id and other row metadata never leave the server).
    -- Null when the realtor has not saved anything yet.
    select data into v_tc_intake
    from tc_intakes
    where escrow_id = v_link.escrow_id;

    return jsonb_build_object(
      'ok', true,
      'role', 'tc',
      'escrow', v_escrow,
      'buyer_steps', v_buyer_steps,
      'seller_steps', v_seller_steps,
      'tc_intake', v_tc_intake,
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
