-- site_settings — small, singular pieces of site configuration that are edited
-- as a whole and read on every page load. The footer is the first one.
--
-- A key/value table rather than a `footer_widgets` table with a row per widget,
-- for the same reason a page's blocks are one JSONB array (0006): the footer is
-- always read and written as one ordered whole, is never queried across
-- widgets, and a reorder should be one atomic update rather than a multi-row
-- rewrite. Shapes are validated in TypeScript at the API boundary
-- (backend/src/lib/site-settings.ts).
--
-- There is deliberately no seed row. The footer's current hardcoded content
-- lives in frontend/src/lib/footer.ts as the default, and an absent row means
-- "nobody has edited the footer yet" — so a failed read, an empty table and a
-- fresh environment all render the same footer visitors see today, instead of
-- an empty one.

create table if not exists public.site_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

comment on table public.site_settings is
  'One row per editable site-wide setting, keyed by name (''footer''). Value shape is validated in the API layer.';

alter table public.site_settings enable row level security;

-- No policies: the only path to a row is the backend service key, inside a
-- handler that has already decided whether the caller may read or write it.
-- As 0002_rls.sql spells out, bypassing RLS is not the same as having
-- privileges, so the grant is still required.
grant select, insert, update, delete on public.site_settings to service_role;
