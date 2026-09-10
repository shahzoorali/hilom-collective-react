-- An explicit "call me this" name for a facilitator.
--
-- `display_name` is one free-text field and doubles as the billing name, so
-- its first word is not always what someone answers to. The first real case
-- was "Miss Kayce" — billed that way, but Kayce to her clients, and greeting
-- her "Hi Miss" reads worse than using the full name. backend/src/lib/names.ts
-- strips a known honorific ("Miss", "Dr.", "Coach", "Ate", …) before taking
-- the first word, which fixes the common shapes without any data entry.
--
-- This column is the override for everything that heuristic cannot know: a
-- facilitator whose actual first name is on the honorific list, one who goes
-- by a middle name or a mononym, one who wants their full name used mid-
-- sentence. When it is null or blank the heuristic still runs, so the vast
-- majority of rows never need it set.
--
-- Public, because it is used in the same sentences `display_name` is — the
-- profile's "About <name>", the booking form's "<name> would like to know".
alter table public.facilitators
  add column if not exists short_name text;

-- Second layer only. Every read goes through Lambda with the secret key, which
-- bypasses RLS; FACILITATOR_PUBLIC_COLUMNS in backend/src/lib/scheduling.ts is
-- what actually shapes the response. The grant is kept in step so a future
-- direct-from-browser query cannot expose more than the API does — same
-- reasoning as 0024.
grant select (short_name) on public.facilitators to anon, authenticated;
