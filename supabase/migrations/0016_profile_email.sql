-- 0016_profile_email.sql — realtor profile email field (Sept 2026).
--
-- email: optional free-text email address on the realtor profile, kept on
--   the realtor side only (it is not part of the public profile pitch page).
--
-- The column is nullable; existing rows keep working and start empty.
--
-- Anuraj applies this in the Supabase dashboard (SQL editor), same as 0008.

alter table public.realtor_profiles
  add column if not exists email text;
