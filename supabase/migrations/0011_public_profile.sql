-- 0009_public_profile.sql — Clear to Close, Sept 2026.
--
-- Public realtor profile page (/realtor/<realtor-id>, approved branding
-- mockup screen 2) + client reviews (approved screen 11).
--
-- REVIEWS ARE PER-REALTOR, SERVER-SIDE (Anuraj, Sept 26):
--   * realtor_profiles gains avg_days_to_close (text) and rating (numeric —
--     the aggregate of that realtor's own reviews, null when none).
--   * A dedicated reviews table keyed by realtor id holds the reviews.
--     Ownership is keyed on the client's client-link id: the anonymous
--     provider stays DISABLED and clients have no login, so the existing
--     client_links device binding IS the client identity. A link may only
--     insert/edit/delete its OWN review (one review per link, enforced by
--     a unique constraint); client_name is taken server-side from the
--     link's party_name, never from the caller.
--   * RLS: the reviews table has NO public policies — anon/authenticated
--     get no direct table access (direct SELECT would expose link_id, the
--     client-link ownership identifier). All reads go through SECURITY
--     DEFINER RPCs that return safe fields only (id, clientName, stars,
--     text, createdAt). Writes happen only through the SECURITY DEFINER
--     upsert_review / delete_review RPCs.
--   * A trigger keeps realtor_profiles.rating in sync on every review
--     insert/update/delete.
--   * get_public_profile(p_realtor_id) — SECURITY DEFINER read for the
--     public page: no login required, executable by anon. Returns the
--     pitch-page fields only (no phone).
--   * get_client_view is re-created ADDITIVELY: the profile payload is the
--     full realtor_profiles row exactly as 0002 returned it (to_jsonb(p))
--     plus the new reviews key, and the response gains my_review_id — this
--     link's own review id, or null — so the client home can open the
--     review sheet in edit mode. Pre-release code keeps working untouched
--     against the migrated DB.
--
-- Anuraj applies this in the Supabase dashboard (SQL editor), same as 0008.

-- ------------------------------------------------------------- new columns --

alter table public.realtor_profiles
  add column if not exists avg_days_to_close text,
  add column if not exists rating numeric null;

-- ------------------------------------------------------------ reviews table --

create table if not exists public.reviews (
  id uuid primary key default gen_random_uuid(),
  realtor_id uuid not null references public.realtor_profiles(user_id) on delete cascade,
  -- The client-link id: the client's identity (device binding). One review
  -- per link; a link may only touch its own row.
  link_id uuid not null references public.client_links(id) on delete cascade,
  client_name text not null,
  stars int not null check (stars between 1 and 5),
  text text not null default '',
  created_at timestamptz not null default now(),
  unique(link_id)
);

create index if not exists reviews_realtor_idx on public.reviews(realtor_id);

alter table public.reviews enable row level security;

-- No public table policies: reviews are read only through the SECURITY
-- DEFINER RPCs below (get_public_profile, get_client_view,
-- upsert_review/delete_review), which return safe fields only. Direct
-- table SELECT would expose link_id, the client-link ownership identifier,
-- so anon/authenticated get no direct table access. (RLS enabled with no
-- policies denies reads/writes by default.)

-- ------------------------------------------------------------ rating trigger --

-- Keeps realtor_profiles.rating = avg(stars) of that realtor's own reviews
-- (null when none) on every review write.
create or replace function maintain_realtor_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_realtor_id uuid;
begin
  v_realtor_id := coalesce(new.realtor_id, old.realtor_id);
  update public.realtor_profiles p
  set rating = (
    select case when count(*) = 0 then null else avg(r.stars)::numeric end
    from public.reviews r
    where r.realtor_id = v_realtor_id
  )
  where p.user_id = v_realtor_id;
  return null;
end;
$$;

drop trigger if exists reviews_rating_trigger on public.reviews;
create trigger reviews_rating_trigger
after insert or update or delete on public.reviews
for each row execute function maintain_realtor_rating();

-- ------------------------------------------------------- public profile RPC --

create or replace function get_public_profile(p_realtor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile jsonb;
begin
  select jsonb_build_object(
    'name', p.name,
    'photo_url', p.photo_url,
    'about', p.about,
    'years_experience', p.years_experience,
    'avg_days_to_close', p.avg_days_to_close,
    'areas_served', p.areas_served,
    'dre_license', p.dre_license,
    'realty_group', p.realty_group,
    'banner_image', p.banner_image,
    'rating', p.rating,
    'reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id::text,
        'clientName', r.client_name,
        'stars', r.stars,
        'text', r.text,
        'createdAt', to_char(r.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by r.created_at desc)
      from public.reviews r
      where r.realtor_id = p.user_id
    ), '[]'::jsonb)
  )
  into v_profile
  from public.realtor_profiles p
  where p.user_id = p_realtor_id;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown');
  end if;
  return jsonb_build_object('ok', true, 'profile', v_profile);
end;
$$;

grant execute on function get_public_profile(uuid) to anon, authenticated;

-- ------------------------------------------------------------- review RPCs --

-- Shared link check for the review writers: returns the link's realtor id
-- when the link exists and is live (not revoked, invite not revoked away).
create or replace function review_link_realtor(p_link_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link client_links%rowtype;
  v_realtor_id uuid;
begin
  select * into v_link from client_links where id = p_link_id;
  if not found or v_link.revoked_at is not null then
    return null;
  end if;
  if exists (select 1 from invites where id = v_link.invite_id and revoked_at is not null) then
    return null;
  end if;
  select e.user_id into v_realtor_id from escrows e where e.id = v_link.escrow_id;
  return v_realtor_id;
end;
$$;

-- Build the public review list JSON for one realtor (newest first).
create or replace function realtor_reviews_json(p_realtor_id uuid)
returns jsonb
language sql
stable
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id::text,
    'clientName', r.client_name,
    'stars', r.stars,
    'text', r.text,
    'createdAt', to_char(r.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) order by r.created_at desc), '[]'::jsonb)
  from public.reviews r
  where r.realtor_id = p_realtor_id;
$$;

create or replace function upsert_review(
  p_link_id uuid,
  p_stars int,
  p_text text,
  p_review_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_realtor_id uuid;
  v_client_name text;
  v_id uuid;
begin
  if p_stars is null or p_stars < 1 or p_stars > 5 then
    return jsonb_build_object('ok', false, 'error', 'stars');
  end if;

  v_realtor_id := review_link_realtor(p_link_id);
  if v_realtor_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  -- True upsert: an explicit id must belong to this link; without one, a
  -- second save updates the link's existing review instead of doubling it.
  if p_review_id is not null then
    select id into v_id from public.reviews
    where id::text = p_review_id and link_id = p_link_id;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'not_found');
    end if;
  else
    select id into v_id from public.reviews where link_id = p_link_id;
  end if;

  select party_name into v_client_name from client_links where id = p_link_id;

  if v_id is null then
    insert into public.reviews (realtor_id, link_id, client_name, stars, text)
    values (v_realtor_id, p_link_id, v_client_name, p_stars, left(coalesce(p_text, ''), 280))
    returning id into v_id;
  else
    update public.reviews
    set stars = p_stars,
        text = left(coalesce(p_text, ''), 280)
    where id = v_id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'review_id', v_id::text,
    'reviews', realtor_reviews_json(v_realtor_id),
    'rating', (select rating from public.realtor_profiles where user_id = v_realtor_id)
  );
end;
$$;

grant execute on function upsert_review(uuid, int, text, text) to anon, authenticated;

create or replace function delete_review(p_link_id uuid, p_review_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_realtor_id uuid;
  v_id uuid;
begin
  v_realtor_id := review_link_realtor(p_link_id);
  if v_realtor_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select id into v_id from public.reviews
  where id::text = p_review_id and link_id = p_link_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  delete from public.reviews where id = v_id;

  return jsonb_build_object(
    'ok', true,
    'reviews', realtor_reviews_json(v_realtor_id),
    'rating', (select rating from public.realtor_profiles where user_id = v_realtor_id)
  );
end;
$$;

grant execute on function delete_review(uuid, text) to anon, authenticated;

-- --------------------------------- get_client_view (reviews + my_review_id) --

-- ROLLBACK SAFETY (Anuraj, Sept 26 — release blocker): this re-creation is
-- ADDITIVE ONLY on the RPC contract. The profile payload is the full
-- realtor_profiles row (to_jsonb(p)) exactly as 0002 returned it — every
-- key old code ever read (id, user_id, deals_closed, created_at,
-- updated_at, ...) is still present — plus the new reviews key. New
-- columns/rows are NULL/empty until written, so pre-release code keeps
-- working untouched against the migrated DB. Validation order and the
-- buyer/seller step keys are unchanged from 0002.
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

  select coalesce(jsonb_agg(to_jsonb(s) order by s.position), '[]'::jsonb)
  into v_steps
  from steps s
  where s.escrow_id = v_link.escrow_id and s.role = v_link.role;

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

grant execute on function get_client_view(uuid) to anon, authenticated;
grant execute on function realtor_reviews_json(uuid) to anon, authenticated;
grant execute on function review_link_realtor(uuid) to anon, authenticated;

-- ------------------------------------ branded invite deep link (Sept 2026) --
--
-- resolve_invite_realtor(p_code): SECURITY DEFINER read for the branded
-- invite welcome. Given a live (unrevoked, unused) invite code, returns the
-- inviting realtor's public branding (name, photo, realty group, DRE) so the
-- client sees WHO invited them before entering their name. Mirrors the
-- redeem_invite validation exactly; executable by anon (no login, no device
-- link yet — the client hasn't redeemed).
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
