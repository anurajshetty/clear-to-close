-- Clear to Close — migration 0008: client push-notification tokens.
--
-- Transport (approved plan): DB trigger -> pg_net -> Supabase Edge Function
-- (`send-client-push`) -> Expo Push API. A DB-level trigger fires on the
-- actual row change no matter which device made it or how late the
-- realtor's cloudSync outbox flushes.
--
-- ADDITIVE-ONLY (rollback requirement, Anuraj Sept 26 2026): this migration
-- creates new tables, new RPCs and new triggers. It never alters, drops or
-- renames existing objects. Rolling the app code back leaves the old code
-- working untouched against the migrated DB.
--
-- KILL SWITCH (rollback requirement, Anuraj Sept 26 2026): the trigger
-- function checks push_config.push_enabled FIRST and no-ops when it is not
-- 'true'. Flip it with:
--   update push_config set value = 'false' where key = 'push_enabled';
-- One-statement trigger disable (no deploy needed either way):
--   alter table steps   disable trigger trg_steps_push_notify;
--   alter table escrows  disable trigger trg_escrows_push_notify;
--
-- Run AFTER 0007. Never edit 0001-0007.
--
-- Dashboard run notes (paste-ready, one script):
--   1. `pg_net` must be enabled: Dashboard -> Database -> Extensions -> pg_net.
--      The `create extension` below is a no-op when it already is.
--   2. `vault` ships enabled on Supabase; the migration mints the trigger
--      shared secret into Vault and prints it once via RAISE NOTICE as
--      PUSH_TRIGGER_SECRET. Copy that value into the Edge Function's secrets
--      (Dashboard -> Edge Functions -> send-client-push -> Secrets) under the
--      SAME name. Never commit it to code.
--   3. The Edge Function needs a second secret, EXPO_ACCESS_TOKEN (created at
--      expo.dev -> Access Tokens). Also set in the function's secrets.

-- ------------------------------------------------------- pg_net + vault --

create extension if not exists pg_net with schema extensions;

-- ------------------------------------------------------------- config --

-- Tiny config table. The trigger reads push_enabled on every fire, so
-- pushes can be paused/resumed without a code deploy.
create table if not exists push_config (
  key text primary key,
  value text not null
);

insert into push_config (key, value)
values
  ('push_enabled', 'true'),
  -- Edge Function endpoint. Defaults to this project's function URL;
  -- override only if the function is renamed or moved.
  ('function_url', 'https://svmqlhhqsgubxcwutanf.supabase.co/functions/v1/send-client-push')
on conflict (key) do nothing;

-- -------------------------------------------------------------- tokens --

create table if not exists push_tokens (
  id uuid primary key default gen_random_uuid(),
  escrow_id uuid not null references escrows(id) on delete cascade,
  device_id text not null,
  link_id uuid not null references client_links(id) on delete cascade,
  expo_push_token text not null,
  updated_at timestamptz not null default now()
);

-- One live token per device: re-registering (reinstall, token rotation)
-- overwrites the row instead of accumulating orphans.
create unique index if not exists push_tokens_device_uidx on push_tokens (device_id);

create index if not exists push_tokens_escrow_idx on push_tokens (escrow_id);

-- RLS: deny everything direct. All access goes through the SECURITY DEFINER
-- RPCs below (clients have no login; the anonymous provider stays
-- disabled) and the Edge Function (service role).
alter table push_tokens enable row level security;

-- ------------------------------------------------------- trigger secret --

-- Mint the shared trigger secret once, keep it in Vault. Printed ONCE via
-- RAISE NOTICE so it can be copied into the Edge Function's secrets.
do $$
declare
  v_secret text;
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'push_trigger_secret') then
    v_secret := encode(gen_random_bytes(32), 'hex');
    perform vault.create_secret(v_secret, 'push_trigger_secret');
    raise notice 'PUSH_TRIGGER_SECRET (copy into the send-client-push Edge Function secrets): %', v_secret;
  end if;
end;
$$;

-- ----------------------------------------------------------------- RPCs --

-- Register (or refresh) this device's Expo push token for one client link.
-- The link must exist and be live (not revoked); a revoked link's device
-- can never receive pushes.
create or replace function register_push_token(p_link_id uuid, p_device_id text, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_link client_links%rowtype;
begin
  if nullif(trim(p_device_id), '') is null or nullif(trim(p_token), '') is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  select * into v_link from client_links where id = p_link_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if v_link.revoked_at is not null then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;
  -- An invite revoked (regenerated away) kills the link's pushes too.
  if exists (select 1 from invites where id = v_link.invite_id and revoked_at is not null) then
    return jsonb_build_object('ok', false, 'error', 'revoked');
  end if;

  insert into push_tokens (escrow_id, device_id, link_id, expo_push_token, updated_at)
  values (v_link.escrow_id, trim(p_device_id), p_link_id, trim(p_token), now())
  on conflict (device_id) do update
    set escrow_id = excluded.escrow_id,
        link_id = excluded.link_id,
        expo_push_token = excluded.expo_push_token,
        updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function register_push_token(uuid, text, text) to anon, authenticated;

-- Drop this device's token (link revoked, client starts over, opt-out).
create or replace function unregister_push_token(p_device_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from push_tokens where device_id = nullif(trim(p_device_id), '');
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function unregister_push_token(text) to anon, authenticated;

-- -------------------------------------------------------------- trigger --

-- Transition-aware push trigger (forward progress ONLY — Anuraj's rule):
--   steps:  INSERT with done = true            -> step_done
--                                             (custom_step_added when custom)
--           UPDATE done false -> true           -> step_done
--           anything else (uncheck, reorder,
--           title edits)                        -> silent
--   escrows: UPDATE close_date changed          -> close_date_changed
--           (buyer_closed_at / seller_closed_at
--            changes do NOT fire)
-- Checks push_config.push_enabled first (kill switch). Fires pg_net async:
-- a slow/dead function never blocks the realtor's write.
create or replace function ctc_push_notify()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_enabled text;
  v_fn_url text;
  v_secret text;
  v_event text := null;
  v_escrow_id uuid;
  v_step_title text := null;
  v_new_close_date date := null;
begin
  select value into v_enabled from push_config where key = 'push_enabled';
  if v_enabled is distinct from 'true' then
    return new;
  end if;

  if TG_TABLE_NAME = 'steps' then
    v_escrow_id := new.escrow_id;
    if TG_OP = 'INSERT' and new.done then
      v_event := case when new.custom then 'custom_step_added' else 'step_done' end;
      v_step_title := new.title;
    elsif TG_OP = 'UPDATE' and old.done = false and new.done = true then
      v_event := 'step_done';
      v_step_title := new.title;
    end if;
  elsif TG_TABLE_NAME = 'escrows' then
    v_escrow_id := new.id;
    if TG_OP = 'UPDATE' and old.close_date is distinct from new.close_date then
      v_event := 'close_date_changed';
      v_new_close_date := new.close_date;
    end if;
  end if;

  if v_event is null then
    return new;
  end if;

  select value into v_fn_url from push_config where key = 'function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_trigger_secret';

  -- Async: pg_net queues the POST outside the transaction. If the secret or
  -- URL is missing, skip silently rather than breaking the write.
  if v_fn_url is not null and v_secret is not null then
    perform net.http_post(
      url := v_fn_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Trigger-Secret', v_secret
      ),
      body := jsonb_build_object(
        'event', v_event,
        'escrow_id', v_escrow_id,
        'step_title', v_step_title,
        'new_close_date', v_new_close_date
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_steps_push_notify on steps;
create trigger trg_steps_push_notify
  after insert or update on steps
  for each row execute function ctc_push_notify();

drop trigger if exists trg_escrows_push_notify on escrows;
create trigger trg_escrows_push_notify
  after update on escrows
  for each row execute function ctc_push_notify();
