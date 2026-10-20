-- 0042_p3_halfway_milestone.sql
--
-- P3 halfway milestone (Oct 15, 2026; approved phased plan + copy):
-- when an escrow's checklist crosses 50% done, the clients + TC get
-- "You're halfway there: {done} of {total} steps done." — ONCE per
-- escrow, ever.
--
-- DESIGN:
--   * Detection lives in ctc_push_notify (the steps trigger), which
--     re-creates here from 0040 VERBATIM except two identical lines —
--     `perform ctc_maybe_push_halfway(new.escrow_id);` after each
--     forward check-off branch's activity stamp. (The diff is pinned
--     programmatically by tests/p3_halfway_migration.py.)
--   * ctc_maybe_push_halfway counts the escrow's steps in the
--     post-write state: crossing means done*2 >= total AND
--     (done-1)*2 < total (this check-off is the one that reached the
--     halfway line). It then claims the milestone ATOMICALLY —
--     UPDATE escrows SET halfway_push_sent_at WHERE it is still NULL —
--     and only the claim winner inserts the outbox row, so concurrent
--     check-offs can never double-fire. Unchecks never call it (the
--     trigger's step_done branches are forward-only) and never clear
--     the stamp: the milestone is once per escrow, period.
--   * Delivery rides the P1 outbox + drain (0040): clients + TC via
--     live tokens at drain, quiet hours + kill switch inherited. The
--     payload snapshots {done, total} at crossing time — the copy
--     reports the crossing counts even if more steps complete before
--     the drain runs.
--   * ctc_maybe_push_halfway is SECURITY DEFINER like the other push
--     trigger functions and is called only from the trigger (which is
--     already kill-switch gated); it is not a client-facing RPC.
--
-- Deploy order: run this migration, THEN redeploy send-client-push.

-- ------------------------------------------------------ once-per-escrow --

alter table escrows add column if not exists halfway_push_sent_at timestamptz;

-- The P1 outbox learns the milestone event.
alter table pending_event_pushes drop constraint if exists pending_event_pushes_event_check;
alter table pending_event_pushes
  add constraint pending_event_pushes_event_check
  check (event in (
    'client_joined', 'review_submitted', 'custom_step_added',
    'escrow_closed', 'escrow_cancelled',
    'buyer_intake_submitted', 'seller_intake_submitted',
    'halfway_milestone'
  ));

-- -------------------------------------------------------- halfway claim --

create or replace function ctc_maybe_push_halfway(p_escrow_id uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_total int;
  v_done int;
  v_claimed int;
begin
  select count(*), count(*) filter (where done)
    into v_total, v_done
    from steps
   where escrow_id = p_escrow_id;
  if v_total is null or v_total = 0 then
    return;
  end if;
  -- Crossing test against the post-write counts: this check-off moved
  -- the escrow from below half to at-or-above half.
  if not (v_done * 2 >= v_total and (v_done - 1) * 2 < v_total) then
    return;
  end if;
  -- Atomic once-per-escrow claim: exactly one caller wins the stamp.
  update escrows
     set halfway_push_sent_at = now()
   where id = p_escrow_id
     and halfway_push_sent_at is null;
  get diagnostics v_claimed = row_count;
  if v_claimed = 1 then
    insert into pending_event_pushes (escrow_id, event, payload)
    values (
      p_escrow_id,
      'halfway_milestone',
      jsonb_build_object('done', v_done, 'total', v_total)
    );
  end if;
end;
$$;

-- -------------------------------------------------- trigger (from 0040) --

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
    -- Unchecks / reorders / title edits insert nothing (forward progress
    -- only). A checked custom step is a normal completion. A custom
    -- step ADDED (not done) queues a P1 event instead (0040).
    if TG_OP = 'INSERT' and new.custom and not new.done then
      insert into pending_event_pushes (escrow_id, event, payload)
      values (new.escrow_id, 'custom_step_added',
              jsonb_build_object('step_role', new.role));
    end if;
    if TG_OP = 'INSERT' and new.done then
      insert into pending_step_pushes (escrow_id, event, step_title, step_role)
      values (new.escrow_id, 'step_done', new.title, new.role);
      update escrows set last_checkoff_activity_at = now()
      where id = new.escrow_id;
      perform ctc_maybe_push_halfway(new.escrow_id);
    elsif TG_OP = 'UPDATE' and old.done = false and new.done = true then
      insert into pending_step_pushes (escrow_id, event, step_title, step_role)
      values (new.escrow_id, 'step_done', new.title, new.role);
      update escrows set last_checkoff_activity_at = now()
      where id = new.escrow_id;
      perform ctc_maybe_push_halfway(new.escrow_id);
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

-- Grant posture (auditor pattern, pinned in the static suite): trigger
-- functions are never directly callable by client roles. CREATE OR
-- REPLACE preserves privileges, so these restate 0040's posture.
revoke execute on function ctc_push_notify() from public, anon, authenticated;
revoke execute on function ctc_maybe_push_halfway(uuid) from public, anon, authenticated;
