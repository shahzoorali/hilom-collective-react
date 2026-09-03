-- Privacy Policy page row and its footer link.
--
-- Separate from 0002 because that file's footer-menu insert is guarded on the
-- menu being empty, so re-running it adds nothing to a database that has
-- already been seeded. This one keys on the item's href instead and can be run
-- against a live site.
--
-- Like the other pages, this is created as an EMPTY draft: scripts/seed-cms.ts
-- writes the copy, and CmsOrFallback keeps serving
-- frontend/src/pages/PrivacyPolicy.tsx until an admin presses Publish.
--
-- is_system = true: the footer links to this slug and the route in App.tsx
-- names it, so it can be edited and unpublished but not renamed or deleted.
insert into public.pages (slug, title, status, is_system)
values ('privacy-policy', 'Privacy Policy', 'draft', true)
on conflict (slug) do nothing;

insert into public.menu_items (menu_id, position, label, href, target)
select m.id,
       coalesce((select max(existing.position) + 1 from public.menu_items existing where existing.menu_id = m.id), 0),
       'Privacy Policy',
       '/privacy-policy',
       'self'
from public.menus m
where m.key = 'footer'
  and not exists (
    select 1 from public.menu_items existing
    where existing.menu_id = m.id and existing.href = '/privacy-policy'
  );
