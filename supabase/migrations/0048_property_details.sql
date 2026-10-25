-- Migration 0048: property details on the escrow (Oct 25, 2026 packet).
--
-- Eight optional columns on escrows: bedrooms, bathrooms (halves
-- allowed), square footage, lot size + unit, property type, year
-- built, listed price — entered on the escrow form, shown as one
-- compact line under the address (realtor page + client views).
--
-- get_client_view: the escrow payload gains the new columns as
-- EXPLICIT KEYS ONLY (appended to the 0035 allow-list in table
-- order) — the M3 explicit-list discipline is unchanged, no other
-- payload key moves, and no intake payload changes shape: the buyer
-- branch still carries no buyer_intake, the seller branch still
-- carries no listing intake, the tc branch keeps its 0031/0034
-- intake payloads exactly as before.
--
-- No new tables (the Oct 30, 2026 explicit-grants rule is not
-- triggered). No policy changes: the existing escrows policies are
-- row-level, so the new content columns ride them — an Associate's
-- member PATCH carrying the new fields is authorized by the same
-- 0044/0046 UPDATE policy as every other content field (proven by
-- the chain probe). No trigger changes: ctc_activity_escrows reacts
-- only to INSERT, close_date changes, and status transitions, so
-- property-detail edits write no escrow_activity rows — before or
-- after this migration.
--
-- The function body below is the migration-0035 definition verbatim
-- (extracted programmatically, both markers asserted) with only the
-- eight escrow keys appended.

alter table escrows
  add column if not exists bedrooms int,
  add column if not exists bathrooms numeric(4,1),
  add column if not exists sqft int,
  add column if not exists lot_size numeric(12,2),
  add column if not exists lot_unit text not null default 'sqft',
  add column if not exists property_type text,
  add column if not exists year_built int,
  add column if not exists listed_price numeric(14,2);

alter table escrows
  add constraint escrows_lot_unit_check
    check (lot_unit in ('sqft', 'acres')),
  add constraint escrows_property_type_check
    check (property_type is null or property_type in
      ('single_family', 'condo', 'townhouse', 'multi_family', 'land', 'other')),
  add constraint escrows_property_details_nonnegative
    check ((bedrooms is null or bedrooms >= 0)
      and (bathrooms is null or bathrooms >= 0)
      and (sqft is null or sqft >= 0)
      and (lot_size is null or lot_size >= 0)
      and (listed_price is null or listed_price >= 0));

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
  v_buyer_intake jsonb;
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

  -- M3: explicit escrow allow-list (was to_jsonb(e) — whole row).
  -- All 19 escrows columns, in table order. user_id stays (public-profile
  -- link contract). Any column added later can no longer auto-leak.
  select jsonb_build_object(
    'id', e.id,
    'user_id', e.user_id,
    'address', e.address,
    'city', e.city,
    'side', e.side,
    'buyer_name', e.buyer_name,
    'seller_name', e.seller_name,
    'open_date', e.open_date,
    'close_date', e.close_date,
    'status', e.status,
    'created_at', e.created_at,
    'buyer_closed_at', e.buyer_closed_at,
    'seller_closed_at', e.seller_closed_at,
    'last_action', e.last_action,
    'inspection_deadline', e.inspection_deadline,
    'appraisal_deadline', e.appraisal_deadline,
    'loan_approval_date', e.loan_approval_date,
    'last_quiet_checkin_at', e.last_quiet_checkin_at,
    'last_checkoff_activity_at', e.last_checkoff_activity_at,
    'bedrooms', e.bedrooms,
    'bathrooms', e.bathrooms,
    'sqft', e.sqft,
    'lot_size', e.lot_size,
    'lot_unit', e.lot_unit,
    'property_type', e.property_type,
    'year_built', e.year_built,
    'listed_price', e.listed_price
  )
  into v_escrow from escrows e where e.id = v_link.escrow_id;

  select e.user_id into v_realtor_id from escrows e where e.id = v_link.escrow_id;

  -- 0017: explicit profile field list (email stays realtor-side only).
  -- 0033: review links ride along for the client home review card.
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
    'google_review_link', p.google_review_link,
    'realtor_com_review_link', p.realtor_com_review_link,
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

    -- 0034: the saved buyer intake rides the tc branch only, as the
    -- data payload (owner_id and other row metadata never leave the
    -- server). Null when the realtor has not saved anything yet.
    select data into v_buyer_intake
    from buyer_intakes
    where escrow_id = v_link.escrow_id;

    return jsonb_build_object(
      'ok', true,
      'role', 'tc',
      'escrow', v_escrow,
      'buyer_steps', v_buyer_steps,
      'seller_steps', v_seller_steps,
      'tc_intake', v_tc_intake,
      'buyer_intake', v_buyer_intake,
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
