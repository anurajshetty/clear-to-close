-- 0015_client_view_status.sql
--
-- Review gate (Anuraj's rule, Sept 2026): a client can leave a review only
-- when the full checklist is 100% complete AND the escrow was not
-- cancelled. The client view must therefore carry the escrow's lifecycle
-- status explicitly.
--
-- ADDITIVE ONLY: re-creates get_client_view with the identical 0012
-- contract (buyer/seller/TC branches, revoked checks, full-row profile +
-- reviews + my_review_id) plus an explicit 'status' key merged into the
-- escrow payload. No columns changed, no data touched, no behavior change
-- for existing callers. Old app builds keep working unchanged.

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
