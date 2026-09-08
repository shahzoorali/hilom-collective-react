-- Menu items can render as a plain nav link (the default) or as a primary
-- button, so a call-to-action like "Join our community" can live in the
-- editable header menu instead of being hardcoded in Layout.tsx.
--
-- Append-only: 0006 created menu_items and the database has diverged from it,
-- so this is a new migration rather than an edit.

alter table public.menu_items
  add column if not exists style text not null default 'link'
    check (style in ('link', 'button'));
