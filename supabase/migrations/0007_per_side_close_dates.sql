-- 0007_per_side_close_dates.sql — escrow lifecycle (Sept 2026).
--
-- Per-side close dates for the dual-agency lifecycle: each side of an escrow
-- closes independently, so the close timestamp lives per side, not on the
-- escrow row's legacy status column.
--
-- Apply on the Supabase dashboard (SQL editor) — paste-ready. Until this is
-- applied, the app still runs: escrow upserts fall back to the pre-migration
-- column set (close dates stay local-only) instead of failing.
alter table public.escrows
  add column if not exists buyer_closed_at date,
  add column if not exists seller_closed_at date;
