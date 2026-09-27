-- 0010_realty_group.sql — realtor profile branding fields (Sept 2026).
--
-- realty_group: optional free-text brokerage shown on the branded client
--   surfaces per the approved branding mockups, e.g.
--   "Maya Sharma / Compass Realty · DRE #01998877".
-- banner_image: optional banner image URI shown behind the client home top
--   card (null = the top card renders its teal gradient fallback). Stored
--   device-local as one managed file, same pattern as the profile photo;
--   file:// URIs pass through, data:/blob: captures never sync.
--
-- Both columns are nullable; existing rows keep working and start empty.
--
-- Apply on the Supabase dashboard (SQL editor) — paste-ready. Until this is
-- applied, the app still runs: profile upserts fall back to the pre-migration
-- column set and profile pulls fall back to the legacy select (both fields
-- stay local-only) instead of failing.
alter table public.realtor_profiles
  add column if not exists realty_group text,
  add column if not exists banner_image text;
