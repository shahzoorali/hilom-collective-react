-- CMS seed: the five existing pages and both menus.
--
-- Pages are created with EMPTY blocks and status 'draft' on purpose. Blocks are
-- filled in by scripts/seed-cms.ts, which has to upload the bundled images to
-- the media bucket first and needs the resulting URLs. Until an admin presses
-- Publish, CmsOrFallback keeps serving the original hardcoded React pages, so
-- running this seed changes nothing a visitor can see.
--
-- No form is seeded: the community signup form already relays to SES via
-- backend/src/handlers/community.ts and keeps doing so through the
-- `communityForm` block. The `forms` tables are for forms an admin creates.
--
-- Re-runnable: every insert is idempotent on its natural key.

-- ---------------------------------------------------------------------------
-- Pages. is_system = true: the nav and in-page CTAs link to these slugs from
-- code, so they can be edited and unpublished but not renamed or deleted.
-- ---------------------------------------------------------------------------
insert into public.pages (slug, title, status, is_system)
values
  ('home',      'Home',              'draft', true),
  ('about',     'About Hilom',       'draft', true),
  ('services',  'Services',          'draft', true),
  ('events',    'Events',            'draft', true),
  ('community', 'Join Our Community','draft', true)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Menus — the header links are exactly what Layout.tsx hardcoded, in order.
-- ---------------------------------------------------------------------------
insert into public.menus (key, label)
values ('header', 'Header navigation'), ('footer', 'Footer links')
on conflict (key) do nothing;

insert into public.menu_items (menu_id, position, label, href, target)
select m.id, v.position, v.label, v.href, v.target
from public.menus m
join (values
  (0, 'About Hilom',                    '/about',     'self'),
  (1, 'Services',                       '/services',  'self'),
  (2, 'Events',                         '/events',    'self'),
  (3, 'Join Our Community',             '/community', 'self'),
  (4, 'Courses',                        '/courses',   'self'),
  (5, 'Login to Hilom Learning Hub ➞', 'https://www.learn.hilomcollective.com', 'blank')
) as v(position, label, href, target) on true
where m.key = 'header'
  and not exists (select 1 from public.menu_items existing where existing.menu_id = m.id);

insert into public.menu_items (menu_id, position, label, href, target)
select m.id, 0, 'Learning platform', 'https://www.learn.hilomcollective.com', 'blank'
from public.menus m
where m.key = 'footer'
  and not exists (select 1 from public.menu_items existing where existing.menu_id = m.id);
