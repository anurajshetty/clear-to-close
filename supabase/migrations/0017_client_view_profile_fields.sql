-- 0017_client_view_profile_fields.sql — get_client_view ships an explicit
-- profile field list instead of the full realtor_profiles row (Sept 2026).
--
-- PROBLEM: get_client_view serialized the full profile row via to_jsonb(p).
-- The 0016 email column is realtor-side only (phone is client-visible by
-- design for Call/Text) — so every linked client received the realtor's
-- email address in the client-view payload. get_public_profile (0011)
-- already uses an explicit field list that excludes phone/email; this brings
-- the client view to the same explicit-field discipline.
--
-- The new payload keeps every key app code ever read from the client-view
-- profile (fromProfileRow in src/lib/cloudSync.ts): name, photo_url,
-- banner_image, about, years_experience, areas_served, phone, dre_license,
-- realty_group, rating, reviews — minus email and the other internal
-- columns (id, user_id, deals_closed, avg_days_to_close, created_at,
-- updated_at). Keys app code never read are dropped; nothing app code reads
-- is renamed, so old and new app builds work unchanged against the migrated
-- DB (fromProfileRow tolerates missing keys).
--
-- Additive only on the RPC contract: no columns changed, no data touched.
--
-- Anuraj applies this in the Supabase dashboard (SQL editor), same as 0008.

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

  -- 0015: the escrow lifecycle status is an explicit contract key (it also
  -- rides along inside to_jsonb(e), but the client review gate reads it, so
  -- pin it explicitly rather than relying on full-row serialization).
  select to_jsonb(e) || jsonb_build_object('status', e.status)
  into v_escrow from escrows e where e.id = v_link.escrow_id;

  select e.user_id into v_realtor_id from escrows e where e.id = v_link.escrow_id;

  -- 0017: explicit profile field list. Every key the app reads from the
  -- client-view profile stays present (phone is client-visible by design
  -- for Call/Text); email stays realtor-side only and no longer ships to
  -- linked clients. Internal columns (id, user_id, deals_closed,
  -- avg_days_to_close, created_at, updated_at) are dropped too — app code
  -- never read them.
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
