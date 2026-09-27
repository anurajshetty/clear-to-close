-- 0014_realtor_media.sql
--
-- Realtor photo + banner sync via Supabase Storage (Sept 2026, Anuraj-approved):
-- the realtor's profile photo and banner upload to a public bucket so client
-- devices can see them. Previously photos stayed device-local.
--
-- Bucket: realtor-media (public read). Path convention (contractual — the app
-- uploads here and reads the public URL back):
--   <auth.uid()>/photo.jpg
--   <auth.uid()>/banner.jpg
-- Single overwrite files: every upload upserts the same path, so exactly one
-- photo and one banner exist per realtor.
--
-- ADDITIVE ONLY: new bucket + storage policies. No tables touched.

-- Create the bucket (idempotent).
insert into storage.buckets (id, name, public)
values ('realtor-media', 'realtor-media', true)
on conflict (id) do update set public = true;

-- Public read: anyone (including logged-out clients opening a branded invite
-- link or the public realtor page) can read the media.
drop policy if exists "Public read realtor media" on storage.objects;
create policy "Public read realtor media"
on storage.objects for select
using (bucket_id = 'realtor-media');

-- A realtor can upload / overwrite / delete only their own files: the first
-- path folder must equal their auth.uid().
drop policy if exists "Realtor manages own media" on storage.objects;
create policy "Realtor manages own media"
on storage.objects for all
using (
  bucket_id = 'realtor-media'
  and auth.uid()::text = (storage.foldername(name))[1]
)
with check (
  bucket_id = 'realtor-media'
  and auth.uid()::text = (storage.foldername(name))[1]
);
