-- 0013_invite_role.sql
--
-- Invite role in resolve_invite_realtor (Sept 2026):
-- the branded redeem form shows the invite's role label ("Transaction
-- Coordinator" for TC invites, "client" for buyer/seller). The resolver now
-- returns the invite's role alongside the realtor branding.
--
-- ADDITIVE ONLY: adds the 'role' key to the resolve_invite_realtor JSON
-- payload. No columns changed, no data touched, all 0011 behavior preserved.

create or replace function resolve_invite_realtor(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
  v_profile realtor_profiles%rowtype;
begin
  select * into v_invite
  from invites
  where code = upper(trim(p_code));

  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_invite.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;

  if v_invite.redeemed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  select p.* into v_profile
  from realtor_profiles p
  join escrows e on e.user_id = p.user_id
  where e.id = v_invite.escrow_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown');
  end if;

  return jsonb_build_object(
    'ok', true,
    'role', v_invite.role,
    'realtor', jsonb_build_object(
      'name', v_profile.name,
      'photo_url', v_profile.photo_url,
      'realty_group', v_profile.realty_group,
      'dre_license', v_profile.dre_license,
      'realtor_id', v_profile.user_id
    )
  );
end;
$$;

grant execute on function resolve_invite_realtor(text) to anon, authenticated;
