-- 0049 — Activity display names: snapshot first, live profile as the
-- null-fill (Fix A, auditor-passed Oct 28, 2026).
--
-- The defect: escrow_activity.actor_name is a frozen write-time snapshot
-- (0044). When the actor had no profile name at write time, the snapshot
-- is NULL and the row renders "Someone" forever — even after the actor
-- names their profile (Mariah's Nightingale feed).
--
-- The fix is READ-TIME ONLY, inside the one gated read path: the
-- list_escrow_activity RPC (owner / accepted members only, via
-- escrow_access_role). The displayed name is now:
--   1. the row's frozen snapshot, when non-empty (history survives
--      renames — a named snapshot NEVER changes);
--   2. else the actor's CURRENT profile name, resolved live;
--   3. else NULL (the app renders "Someone").
-- Blank/whitespace counts as missing at BOTH levels. The table is not
-- written (append-only posture intact), no profile read policy changes,
-- and there is no general by-uid lookup — resolution happens only for
-- rows the caller is already entitled to read, inside the definer.
--
-- Body is 0044's verbatim except the actor_name expression. No new
-- tables (no grants implications under the Oct 30, 2026 rule).

create or replace function list_escrow_activity(p_escrow_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when escrow_access_role(p_escrow_id) is null then '[]'::jsonb
    else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'kind', a.kind, 'actor_id', a.actor_id,
        'actor_name', coalesce(
          nullif(trim(a.actor_name), ''),
          (select nullif(trim(p.name), '')
             from realtor_profiles p
            where p.user_id = a.actor_id)
        ),
        'actor_label', a.actor_label,
        'detail', a.detail, 'created_at', a.created_at
      ) order by a.created_at desc)
      from (
        select * from escrow_activity
        where escrow_id = p_escrow_id
        order by created_at desc
        limit 200
      ) a
    ), '[]'::jsonb)
  end;
$$;

revoke all on function list_escrow_activity(uuid) from public, anon;
grant execute on function list_escrow_activity(uuid) to authenticated;
