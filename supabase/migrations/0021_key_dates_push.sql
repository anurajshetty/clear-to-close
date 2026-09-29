-- Clear to Close — migration 0021: key-date changes fire the client push.
--
-- Extends the 0008 push trigger (forward-progress-only, Anuraj's rule):
--   escrows: UPDATE close_date / inspection_deadline / appraisal_deadline /
--            loan_approval_date changed -> specific per-date event (one date)
--            or key_dates_changed (several dates together).
--
-- Anuraj's approved copy rule (Sept 28, 2026):
--   One date changed:   specific copy, e.g. "Your closing date is now Nov 15, 2026."
--   Several dates together: "{First} updated your key dates."
--
-- The trigger counts changed date fields: exactly one -> the specific event
-- for that field (with new_date); two or more -> key_dates_changed.
-- The steps half is untouched.
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
  v_new_date date := null;
  v_changed_count int := 0;
  v_changed_field text := null;
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
      -- Count changed key-date fields (Anuraj Sept 28, 2026: one date ->
      -- specific copy; several together -> generic "updated your key dates").
      -- A clear counts: the realtor removed a date the client could see.
      if old.close_date is distinct from new.close_date then
        v_changed_count := v_changed_count + 1;
        v_changed_field := 'close_date';
        v_new_date := new.close_date;
      end if;
      if old.inspection_deadline is distinct from new.inspection_deadline then
        v_changed_count := v_changed_count + 1;
        v_changed_field := 'inspection_deadline';
        v_new_date := new.inspection_deadline;
      end if;
      if old.appraisal_deadline is distinct from new.appraisal_deadline then
        v_changed_count := v_changed_count + 1;
        v_changed_field := 'appraisal_deadline';
        v_new_date := new.appraisal_deadline;
      end if;
      if old.loan_approval_date is distinct from new.loan_approval_date then
        v_changed_count := v_changed_count + 1;
        v_changed_field := 'loan_approval_date';
        v_new_date := new.loan_approval_date;
      end if;

      if v_changed_count = 1 then
        -- Exactly one date changed: specific event + the new date.
        case v_changed_field
          when 'close_date' then
            v_event := 'close_date_changed';
            v_new_close_date := v_new_date; -- legacy payload field
          when 'inspection_deadline' then
            v_event := 'inspection_deadline_changed';
          when 'appraisal_deadline' then
            v_event := 'appraisal_deadline_changed';
          when 'loan_approval_date' then
            v_event := 'loan_approval_date_changed';
        end case;
      elsif v_changed_count > 1 then
        -- Several dates changed together: the generic copy.
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
        'new_close_date', v_new_close_date,
        'new_date', v_new_date
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
