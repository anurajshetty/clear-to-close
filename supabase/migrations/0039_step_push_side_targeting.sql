-- 0039_step_push_side_targeting.sql
--
-- P0.3 side-aware push targeting (Oct 15, 2026): step pushes go to the
-- devices of that step's side + TC, not to every client device on the
-- escrow. Until now the coalescing buffer recorded no side, so the
-- flush had nothing to target by.
--
-- This migration does exactly two things:
--   1. pending_step_pushes gains step_role (the checked step's
--      steps.role, 'buyer' | 'seller'). Nullable: rows buffered by the
--      old trigger in the minutes around deployment carry NULL, and
--      the flush treats NULL as "both audiences" so nothing buffered
--      pre-deploy is silently dropped or mistargeted.
--   2. ctc_push_notify() is re-created with its 0024 body VERBATIM
--      except the two pending_step_pushes inserts, which now also
--      record new.role. (Extracted programmatically from 0024 and
--      diffed - the escrows/key-date branch and the pg_net post are
--      byte-identical.)
--
-- The targeting rules themselves live in the send-client-push Edge
-- Function (pure helpers in push.ts): step events -> the step's side +
-- TC; close_date_changed / key_dates_changed -> all parties;
-- inspection/appraisal/loan deadline events -> buyer side + TC.
-- Quiet hours, coalescing, the kill switch, and send-time liveness
-- checks are unchanged.

alter table pending_step_pushes
  add column if not exists step_role text
    check (step_role in ('buyer', 'seller'));

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
    -- Buffer, don't POST: the per-minute flush coalesces rapid check-offs.
    -- Unchecks / reorders / title edits / structural adds insert nothing
    -- (forward progress only). A checked custom step is a normal
    -- completion — structural edits never push.
    if TG_OP = 'INSERT' and new.done then
      insert into pending_step_pushes (escrow_id, event, step_title, step_role)
      values (new.escrow_id, 'step_done', new.title, new.role);
      update escrows set last_checkoff_activity_at = now()
      where id = new.escrow_id;
    elsif TG_OP = 'UPDATE' and old.done = false and new.done = true then
      insert into pending_step_pushes (escrow_id, event, step_title, step_role)
      values (new.escrow_id, 'step_done', new.title, new.role);
      update escrows set last_checkoff_activity_at = now()
      where id = new.escrow_id;
    end if;
    return new;
  elsif TG_TABLE_NAME = 'escrows' then
    v_escrow_id := new.id;
    if TG_OP = 'UPDATE' then
      -- 0021 logic verbatim: count changed key-date fields.
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
        case v_changed_field
          when 'close_date' then
            v_event := 'close_date_changed';
            v_new_close_date := v_new_date;
          when 'inspection_deadline' then
            v_event := 'inspection_deadline_changed';
          when 'appraisal_deadline' then
            v_event := 'appraisal_deadline_changed';
          when 'loan_approval_date' then
            v_event := 'loan_approval_date_changed';
        end case;
      elsif v_changed_count > 1 then
        v_event := 'key_dates_changed';
      end if;
    end if;
  end if;

  if v_event is null then
    return new;
  end if;

  select value into v_fn_url from push_config where key = 'function_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_trigger_secret';

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
