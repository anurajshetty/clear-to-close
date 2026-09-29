-- Clear to Close — migration 0021: key-date changes fire the client push.
--
-- Extends the 0008 push trigger (forward-progress-only, Anuraj's rule):
--   escrows: UPDATE inspection_deadline / appraisal_deadline /
--            loan_approval_date changed  -> key_dates_changed
-- The steps half and close_date_changed are untouched.
--
-- One event per write: when the close date AND a key date change in the
-- same update, close_date_changed takes precedence (the single-event
-- shape predates this migration).
--
-- DEPLOY ORDER: apply AFTER 0019 (the key-date columns) and 0020. Then
-- redeploy the `send-client-push` Edge Function with the matching
-- key_dates_changed copy — an un-upgraded function drops unknown events
-- (parseTriggerPayload returns null -> 400), so it never misfires.
--
-- ADDITIVE-ONLY (rollback requirement, Anuraj Sept 26 2026): this migration
-- only CREATE OR REPLACEs the trigger function and recreates the two
-- existing triggers. No table or column changes; rolling the app code back
-- leaves the old code working untouched against the migrated DB.
--
-- KILL SWITCH: unchanged — push_config.push_enabled, or
--   alter table escrows disable trigger trg_escrows_push_notify;

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
    if TG_OP = 'UPDATE' then
      if old.close_date is distinct from new.close_date then
        v_event := 'close_date_changed';
        v_new_close_date := new.close_date;
      elsif old.inspection_deadline is distinct from new.inspection_deadline
         or old.appraisal_deadline is distinct from new.appraisal_deadline
         or old.loan_approval_date is distinct from new.loan_approval_date then
        -- Any key-date add/change is client-visible forward information.
        -- (A clear counts: the realtor removed a date the client could see.)
        -- The copy is the neutral "updated your key dates".
        v_event := 'key_dates_changed';
      end if;
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
