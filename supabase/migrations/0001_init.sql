-- Clear to Close — initial schema (0001).
-- Realtor-owned rows are protected by RLS (owner = auth.uid() = user_id).
-- Client (buyer/seller) access goes through the SECURITY DEFINER functions
-- redeem_invite() and get_client_view(), executable by anon/authenticated.

-- ---------------------------------------------------------------- tables --

create table realtor_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  name text,
  photo_url text,
  about text,
  years_experience text,
  deals_closed text,
  areas_served text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table escrows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  address text not null,
  city text not null,
  side text not null check (side in ('buy', 'sell', 'both')),
  buyer_name text,
  seller_name text,
  open_date date not null,
  close_date date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now()
);

create table steps (
  id uuid primary key default gen_random_uuid(),
  escrow_id uuid not null references escrows(id) on delete cascade,
  role text not null check (role in ('buyer', 'seller')),
  title text not null,
  subtitle text not null default '',
  done boolean not null default false,
  custom boolean not null default false,
  position integer not null,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table invites (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  escrow_id uuid not null references escrows(id) on delete cascade,
  role text not null check (role in ('buyer', 'seller')),
  party_name text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  redeemed_at timestamptz
);

create table client_links (
  id uuid primary key default gen_random_uuid(),
  escrow_id uuid not null references escrows(id) on delete cascade,
  invite_id uuid not null references invites(id),
  role text not null check (role in ('buyer', 'seller')),
  party_name text not null,
  created_at timestamptz not null default now()
);

create index steps_escrow_role_idx on steps (escrow_id, role);
create index invites_code_idx on invites (code);
create index invites_escrow_idx on invites (escrow_id);
create index client_links_escrow_idx on client_links (escrow_id);

-- ------------------------------------------------- row level security --

alter table realtor_profiles enable row level security;
alter table escrows enable row level security;
alter table steps enable row level security;
alter table invites enable row level security;
alter table client_links enable row level security;

-- Realtor owns their own profile and escrows outright.
create policy realtor_profiles_owner on realtor_profiles
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy escrows_owner on escrows
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Child tables inherit ownership through the parent escrow.
create policy steps_owner on steps
  for all
  using (exists (
    select 1 from escrows e
    where e.id = steps.escrow_id and e.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from escrows e
    where e.id = steps.escrow_id and e.user_id = auth.uid()
  ));

create policy invites_owner on invites
  for all
  using (exists (
    select 1 from escrows e
    where e.id = invites.escrow_id and e.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from escrows e
    where e.id = invites.escrow_id and e.user_id = auth.uid()
  ));

create policy client_links_owner on client_links
  for all
  using (exists (
    select 1 from escrows e
    where e.id = client_links.escrow_id and e.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from escrows e
    where e.id = client_links.escrow_id and e.user_id = auth.uid()
  ));

-- ------------------------------------------- invite redemption (RPC) --

-- Single-use, name-bound invite redemption. The guarded UPDATE
-- (redeemed_at is null) is the exactly-one-wins concurrency guard: two
-- simultaneous redemptions of the same code leave exactly one redeemed.
create or replace function redeem_invite(p_code text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invite invites%rowtype;
  v_link_id uuid := gen_random_uuid();
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

  if lower(trim(v_invite.party_name)) <> lower(trim(p_name)) then
    return jsonb_build_object('ok', false, 'error', 'name_mismatch');
  end if;

  update invites
  set redeemed_at = now()
  where id = v_invite.id and redeemed_at is null;

  if not found then
    -- Lost the race to another redemption of the same code.
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  insert into client_links (id, escrow_id, invite_id, role, party_name)
  values (v_link_id, v_invite.escrow_id, v_invite.id, v_invite.role, v_invite.party_name);

  return jsonb_build_object(
    'ok', true,
    'escrow_id', v_invite.escrow_id,
    'role', v_invite.role,
    'party_name', v_invite.party_name,
    'link_id', v_link_id
  );
end;
$$;

grant execute on function redeem_invite(text, text) to anon, authenticated;

-- ---------------------------------------------- client view read (RPC) --

-- Returns the escrow + the steps for the link's role + the realtor profile
-- for a valid client_links id. Role routing comes from the link itself.
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
  v_profile jsonb;
begin
  select * into v_link from client_links where id = p_link_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select to_jsonb(e) into v_escrow from escrows e where e.id = v_link.escrow_id;

  select coalesce(jsonb_agg(to_jsonb(s) order by s.position), '[]'::jsonb)
  into v_steps
  from steps s
  where s.escrow_id = v_link.escrow_id and s.role = v_link.role;

  select to_jsonb(p) into v_profile
  from realtor_profiles p
  where p.user_id = (select e.user_id from escrows e where e.id = v_link.escrow_id);

  if v_link.role = 'buyer' then
    return jsonb_build_object(
      'ok', true,
      'escrow', v_escrow,
      'buyer_steps', v_steps,
      'profile', v_profile
    );
  else
    return jsonb_build_object(
      'ok', true,
      'escrow', v_escrow,
      'seller_steps', v_steps,
      'profile', v_profile
    );
  end if;
end;
$$;

grant execute on function get_client_view(uuid) to anon, authenticated;
