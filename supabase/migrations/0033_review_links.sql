-- 0033_review_links.sql — external review links (Oct 2026, Anuraj).
--
-- The realtor saves optional Google / realtor.com review links on the
-- profile-update screen. After the escrow closes, the client home shows a
-- compact card with the logo buttons; tapping a logo opens the link in the
-- external browser. This REPLACES the in-app review button (the review
-- sheet entry is removed; the review RPCs and stored reviews stay dormant).
--
--   * realtor_profiles gains google_review_link and realtor_com_review_link
--     (text, nullable — empty when the realtor has not set them).
--   * get_client_view is re-created ADDITIVELY: the profile payload gains
--     the two new keys. Everything else is byte-identical to 0031.
--
-- Anuraj applies this in the Supabase dashboard (SQL editor), same as 0008.

alter table public.realtor_profiles
  add column if not exists google_review_link text,
  add column if not exists realtor_com_review_link text;

-- ------------------------------------------------- get_client_view RPC --
-- Replaced in full (same pattern as 0017/0031): the profile payload gains
-- 'google_review_link' and 'realtor_com_review_link'. All branches are
-- otherwise byte-identical to 0031.
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
