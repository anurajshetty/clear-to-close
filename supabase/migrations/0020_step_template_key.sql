-- Key dates release, step template keys (Sept 28, 2026, Anuraj).
--
-- Default steps are matched to their bundled client explainer by a permanent
-- template key (e.g. 'earnest-money-wired'), never by title text: titles are
-- realtor-editable in checklist edit mode. The key is stamped at step
-- creation; older rows backfill it client-side by title match on upgrade.
-- Null for custom steps (custom steps never resolve a default explainer).
alter table steps
  add column if not exists template_key text;
