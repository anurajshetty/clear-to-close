-- 0008_escrow_last_action.sql — "LATEST FROM {NAME}" card (Sept 2026).
--
-- The client home's "LATEST FROM" card shows the single most recent realtor
-- action on the escrow — forward AND backward moves (neutral wording, no
-- blame). An uncheck leaves no completed_at behind, so the action is
-- stamped explicitly as JSONB:
--   {"kind":"checked"|"reopened","stepTitle":"...","at":"<ISO timestamp>"}
--
-- Apply on the Supabase dashboard (SQL editor) — paste-ready. Until this is
-- applied, the app still runs: get_client_view returns the whole escrow row
-- (to_jsonb), so the field simply arrives as null, and escrow pushes fall
-- back to the pre-migration column set instead of failing.
alter table public.escrows
  add column if not exists last_action jsonb;
