-- Phase 5 addendum — course image sync.
--
-- Moodle's course overview image lives behind pluginfile.php and requires the
-- WS token to load. We never store or expose that Moodle URL to the frontend
-- (it would leak the backend's Moodle secret to every visitor); instead the
-- sync downloads the image server-side and re-uploads it to a public Supabase
-- Storage bucket, storing that public URL here.
alter table public.courses
  add column if not exists image_url text;
