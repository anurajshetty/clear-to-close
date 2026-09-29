-- 0019_key_dates.sql — key dates card + custom-step explainers (Sept 28, 2026,
-- Anuraj-approved).
--
-- Three realtor-entered dates on the escrow row, shown read-only on the
-- client "KEY DATES" card (closing date = the existing close_date):
--   inspection_deadline  — inspection contingency deadline
--   appraisal_deadline   — appraisal deadline
--   loan_approval_date   — loan approval date
-- All nullable; local 'YYYY-MM-DD' strings. Escrow-level (not per side).
--
-- One explainer line on the steps row: the realtor's optional one-line
-- "What does this step mean?" on custom steps, shown when the client taps
-- the row. Null until entered.
--
-- No RPC changes needed: get_client_view serializes the escrow row and the
-- step rows via to_jsonb(...), so the new columns ride the existing
-- payloads automatically (the app reads them defensively — pre-0019
-- payloads just show the empty state / no expand).
--
-- Anuraj applies this in the Supabase dashboard (SQL editor), same as 0018.
-- Until then the app's confirmed-write path keeps working: key-date pushes
-- fall back to the pre-0019 column set (the dates stay local-only), and a
-- step carrying an explainer fails its push loudly rather than silently
-- dropping the note.

alter table escrows
  add column if not exists inspection_deadline date,
  add column if not exists appraisal_deadline date,
  add column if not exists loan_approval_date date;

alter table steps
  add column if not exists explainer text;
